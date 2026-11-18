import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Analytics from "../analytics/Analytics.ts";
import * as StartupPhaseLog from "../observability/StartupPhaseLog.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as RestartPacingState from "./RestartPacingState.ts";
import { makeRestartLoad, type RestartLoadSample } from "./RestartLoad.ts";
import {
  OrchestrationV2RestartAdmissionFailure,
  type RunId,
  type ThreadId,
  type ServerSettings as Settings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { RestartPacingStateError, type RestartSource } from "./RestartPacingState.ts";

const RECHECK_MS = 15_000;
const MAX_RECHECK_MS = 60_000;
const MAX_ORDER_RECHECK_MS = 100;
const PASS_MS = 10_000;
const MAX_LOAD_HOLD_MS = 20 * 60_000;
// A deep queue can outlast the load hold while still making progress.
export const RESTART_ADMISSION_TIMEOUT_MS = 30 * 60_000;
const RESTART_ADMISSION_ABSOLUTE_TIMEOUT_MS = 2 * 60 * 60_000;
const BOUND_DEFERRED_LOG_MS = 10 * 60_000;
export class RestartAdmissionTimeoutError extends Schema.TaggedError<RestartAdmissionTimeoutError>()(
  "RestartAdmissionTimeoutError",
  { deadline: Schema.DateTimeUtc, admission: OrchestrationV2RestartAdmissionFailure },
) {}
export class RestartAdmissionSupersededError extends Schema.TaggedError<RestartAdmissionSupersededError>()(
  "RestartAdmissionSupersededError",
  {},
) {}
const DISPATCH_GRACE_MS = 2 * 60_000;
const STUCK_MS = 10 * 60_000;

type AdmissionObservation = {
  positionAtEntry: number;
  maxQueueDepth: number;
  recorded: boolean;
};
type LoadHold = {
  loadHoldMs: number;
  checkedAt: number;
  wasLoaded: boolean;
  observation?: AdmissionObservation;
};
type AdmissionProgress = {
  bestPosition: number;
  positionImprovedAt: number;
  admissionProgressAt: number;
  lastBoundDeferredAt?: number;
};
type WaitingHold = LoadHold &
  Partial<AdmissionProgress> & {
    registeredAt?: number;
    order?: number;
    priority?: number;
    activityAt?: number;
    expiredEffectId?: string;
  };

export class RestartLoad extends Context.Reference<
  (() => number) & { snapshot?: () => RestartLoadSample }
>("t3/ardud/RestartLoad", {
  defaultValue: makeRestartLoad,
}) {}

export class RestartPacing extends Context.Service<
  RestartPacing,
  {
    readonly settingsSnapshot: Effect.Effect<Settings, ServerSettingsError>;
    readonly acquireRun: (
      threadId: ThreadId,
      runId: RunId,
      effectId?: string,
    ) => Effect.Effect<
      number,
      RestartPacingStateError | RestartAdmissionTimeoutError | RestartAdmissionSupersededError
    >;
    readonly register: (source: RestartSource) => Effect.Effect<void, RestartPacingStateError>;
    readonly acquire: (
      source: RestartSource,
    ) => Effect.Effect<
      number,
      RestartPacingStateError | RestartAdmissionTimeoutError | RestartAdmissionSupersededError
    >;
    readonly release: (source: RestartSource) => Effect.Effect<void>;
    readonly releaseRun: (
      threadId: ThreadId,
      runId: RunId,
      effectId?: string,
      retrying?: boolean,
    ) => Effect.Effect<void>;
    readonly dispatched: (
      source: RestartSource,
      declined?: boolean,
    ) => Effect.Effect<void, RestartPacingStateError>;
  }
>()("t3/ardud/restart-pacing/RestartPacing") {}

const make = Effect.gen(function* () {
  const state = yield* RestartPacingState.RestartPacingState;
  const settings = yield* ServerSettings.ServerSettingsService;
  const load = yield* RestartLoad;
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  const startup = yield* Effect.serviceOption(StartupPhaseLog.StartupPhaseLog);
  const bootId = Option.isSome(startup) ? startup.value.snapshot().bootId : undefined;
  const scope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  let changed = yield* Deferred.make<void>();
  const settingsMutex = yield* Semaphore.make(1);
  let snapshot: { at: number; value: Settings } | undefined;
  const readSettingsSnapshot = Effect.fn("RestartPacing.settingsSnapshot")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      if (snapshot === undefined || now - snapshot.at >= PASS_MS) {
        const value = yield* settings.getSettings;
        snapshot = { at: now, value };
      }
      return snapshot.value;
    },
    (effect) => settingsMutex.withPermits(1)(effect),
  );
  const settingsSnapshot = Effect.suspend(readSettingsSnapshot);
  const pending = new Map<
    string,
    RestartSource &
      AdmissionProgress & {
        registeredAt: number;
        order: number;
        runId?: RunId;
        readyAt?: number;
        wakeRequested?: boolean;
        priority: number;
        activityAt: number;
        loadHoldMs: number;
        checkedAt: number;
        wasLoaded: boolean;
        observation?: AdmissionObservation;
        retryMs: number;
        position?: number;
        waitKey?: string;
        orderWait?: { head: string; retryMs: number };
      }
  >();
  // A requeued run can outlive its settled start effect. Keep its load budget
  // across pruning until a replacement effect registers it again.
  const requeuedHolds = new Map<string, WaitingHold>();
  const retiredNotes = new Map<string, RestartSource>();
  const active = new Map<
    string,
    {
      source: RestartSource;
      runId?: RunId;
      dispatching: boolean;
      admittedAt: number;
      hold: LoadHold;
    }
  >();
  let nextOrder = 0;
  const superseded = new Set<string>();
  let lastStartAt: number | undefined;
  let lastProgressAt = 0;
  let pass:
    | {
        at: number;
        config: Settings["restartPacing"];
        loaded: boolean;
        loadScore: number;
        loadSample?: RestartLoadSample;
      }
    | undefined;
  let activeCheckedAt: number | undefined;
  const runSources = new Map<string, RestartSource & { admitted?: boolean; hold?: LoadHold }>();
  const updateLoadHolds = (now: number, loaded: boolean) => {
    for (const entry of pending.values()) {
      if (entry.wasLoaded) entry.loadHoldMs += Math.max(0, now - entry.checkedAt);
      entry.checkedAt = now;
      entry.wasLoaded = loaded;
    }
  };
  const key = (source: RestartSource) => `${source.threadId}:${source.sourceRunId}`;
  const recordAdmission = Effect.fn("RestartPacing.recordAdmission")(function* (
    source: RestartSource,
    observation: AdmissionObservation | undefined,
    outcome: {
      readonly at: number;
      readonly runId: RunId | undefined;
      readonly queuedAtMs: number;
      readonly position: number;
      readonly total: number;
      readonly active: number;
      readonly maxActive: number;
      readonly loaded: boolean;
      readonly rule?: OrchestrationV2RestartAdmissionFailure["rule"];
    },
  ) {
    if (Option.isNone(analytics) || observation === undefined || observation.recorded) return;
    observation.recorded = true;
    const event = {
      ts: DateTime.formatIso(DateTime.makeUnsafe(outcome.at)),
      kind: outcome.rule === undefined ? "restart.admission.admitted" : "restart.admission.failed",
      surface: "server" as const,
      route: "restart-pacing",
      threadId: source.threadId,
      ...(bootId === undefined ? {} : { bootId }),
      restartAdmission: {
        sourceRunId: source.sourceRunId,
        ...(outcome.runId === undefined ? {} : { runId: outcome.runId }),
        classification: source.classification ?? "continuation",
        queuedAtMs: outcome.queuedAtMs,
        waitedMs: outcome.at - outcome.queuedAtMs,
        positionAtEntry: observation.positionAtEntry,
        position: outcome.position,
        total: outcome.total,
        maxQueueDepth: observation.maxQueueDepth,
        active: outcome.active,
        maxActive: outcome.maxActive,
        loaded: outcome.loaded,
        ...(outcome.rule === undefined ? {} : { rule: outcome.rule }),
      },
    };
    // Recording must never hold the pacing mutex or fail a provider start.
    yield* Effect.suspend(() => analytics.value.record(event)).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.forkIn(scope),
    );
  });
  const orderedQueue = (now: number, loaded: boolean) =>
    [...pending.values()].sort(
      (a, b) =>
        Number(
          loaded &&
            a.loadHoldMs + (a.wasLoaded ? Math.max(0, now - a.checkedAt) : 0) < MAX_LOAD_HOLD_MS,
        ) -
          Number(
            loaded &&
              b.loadHoldMs + (b.wasLoaded ? Math.max(0, now - b.checkedAt) : 0) < MAX_LOAD_HOLD_MS,
          ) ||
        a.priority - b.priority ||
        a.order - b.order,
    );
  const noProgressDeadline = (entry: AdmissionProgress) =>
    Math.min(entry.admissionProgressAt, entry.positionImprovedAt) + RESTART_ADMISSION_TIMEOUT_MS;
  // Observe every waiter at queue mutations, including waiters whose durable
  // retries are asleep. A late observation cannot revive an expired window.
  const observeProgress = (
    queue: ReadonlyArray<AdmissionProgress & { observation?: AdmissionObservation }>,
    now: number,
    admitted = false,
  ) => {
    for (const [index, entry] of queue.entries()) {
      // Use the existing queue traversal. Observations live with the reservation
      // and retained retry hold, and are freed when that source settles.
      if (Option.isSome(analytics)) {
        entry.observation ??= {
          positionAtEntry: index + 1,
          maxQueueDepth: queue.length,
          recorded: false,
        };
        entry.observation.maxQueueDepth = Math.max(entry.observation.maxQueueDepth, queue.length);
      }
      if (now >= noProgressDeadline(entry)) continue;
      if (entry.bestPosition === Infinity) {
        // Establishing the queue baseline is not an improvement in position.
        entry.bestPosition = index + 1;
      } else if (index + 1 < entry.bestPosition) {
        entry.bestPosition = index + 1;
        entry.positionImprovedAt = now;
      }
      if (admitted) entry.admissionProgressAt = now;
    }
  };
  // Record readiness with the mutation that changes the head or frees a slot.
  // A late timer must expose the missed deadline instead of resetting its age.
  const queueChanged = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const queue = orderedQueue(now, pass?.loaded ?? false);
    if (pass !== undefined) {
      // Startup registers the whole batch before the first admission pass.
      observeProgress(queue, now);
      const head = queue[0];
      const full = active.size >= pass.config.maxActive;
      for (const entry of queue) if (entry !== head || full) delete entry.readyAt;
      if (head !== undefined && !full) {
        const credit = head.loadHoldMs + (head.wasLoaded ? Math.max(0, now - head.checkedAt) : 0);
        const hold = pass.loaded ? Math.max(0, MAX_LOAD_HOLD_MS - credit) : 0;
        const spacingAt =
          lastStartAt === undefined ? head.registeredAt : lastStartAt + pass.config.spacingMs;
        const readyAt = Math.max(now + hold, spacingAt);
        head.readyAt = hold > 0 ? readyAt : Math.min(head.readyAt ?? readyAt, readyAt);
      }
    }
    yield* Deferred.succeed(changed, undefined);
  });
  // Keep CPU intervals short and wake load-held heads independently of durable retries.
  yield* Effect.sleep(PASS_MS).pipe(
    Effect.andThen(
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const loadScore = load();
          const loaded = loadScore > 1;
          const loadSample = load.snapshot?.();
          updateLoadHolds(now, loaded);
          if (pass !== undefined) {
            const loadChanged = pass.loaded !== loaded;
            pass = {
              ...pass,
              loaded,
              loadScore,
              ...(loadSample === undefined ? {} : { loadSample }),
            };
            if (loadChanged) yield* queueChanged;
          }
        }),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  // Called only under the pacing mutex; the enclosing operation owns tracing.
  const releaseReservation = (source: RestartSource, now: number, retrying = false) => {
    const reservation = active.get(key(source));
    if (reservation === undefined || reservation.source.effectId !== source.effectId) return;
    if (retrying) requeuedHolds.set(key(source), reservation.hold);
    active.delete(key(source));
    lastProgressAt = now;
  };
  const release = Effect.fn("RestartPacing.release")(
    function* (source: RestartSource) {
      releaseReservation(source, yield* Clock.currentTimeMillis, true);
    },
    (effect) => mutex.withPermits(1)(effect.pipe(Effect.ensuring(queueChanged))),
  );
  const releaseRun = Effect.fn("RestartPacing.releaseRun")(
    function* (threadId: ThreadId, runId: RunId, effectId?: string, retrying = false) {
      const runKey = `${threadId}:${runId}`;
      const source = runSources.get(runKey);
      if (source === undefined || source.effectId !== effectId) return;
      // A deferred claim still owns its classification cache and load budget.
      if (!source.admitted) return;
      const reservation = active.get(key(source));
      if (reservation !== undefined && reservation.source.effectId !== effectId) {
        runSources.delete(runKey);
        return;
      }
      // Refresh may already have freed the slot before this failed start unwinds.
      if (retrying && source.hold !== undefined) requeuedHolds.set(key(source), source.hold);
      else if (!retrying) requeuedHolds.delete(key(source));
      releaseReservation(source, yield* Clock.currentTimeMillis);
      if (retrying) runSources.set(runKey, { ...source, admitted: false });
      else runSources.delete(runKey);
    },
    (effect, threadId, runId, effectId) =>
      Effect.suspend(() => {
        // Fresh starts own no reservation. Their finalizers must not queue
        // behind recovery admission's projection reads and occupy start workers.
        const source = runSources.get(`${threadId}:${runId}`);
        if (source === undefined || source.effectId !== effectId || !source.admitted)
          return Effect.void;
        // Re-read ownership under the mutex before changing a reservation.
        return mutex.withPermits(1)(effect.pipe(Effect.ensuring(queueChanged)));
      }),
  );
  // Keep allocation/transfer and its finalizer metadata in the same mutex turn.
  const ownRunReservation = (source: RestartSource, runId: RunId) => {
    const reservation = active.get(key(source));
    if (reservation === undefined) return;
    reservation.runId = runId;
    reservation.source = source;
    reservation.dispatching = false;
    runSources.set(`${source.threadId}:${runId}`, {
      ...source,
      admitted: true,
      hold: reservation.hold,
    });
  };
  const completeRetiredNotes = Effect.fn("RestartPacing.completeRetiredNotes")(function* () {
    for (const [noteKey, source] of retiredNotes) {
      const closed = yield* state.status(source, null).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("restart-pacing.retired-note-cleanup-failed", {
            threadId: source.threadId,
            sourceRunId: source.sourceRunId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (closed) retiredNotes.delete(noteKey);
    }
  });
  const retire = Effect.fn("RestartPacing.retire")(function* (
    source: RestartSource,
    retainHold = false,
  ) {
    if (!(yield* state.status(source, null))) {
      // A replacement still owns the note. Keep cleanup reachable by the next
      // admission pass without keeping this retired source in the queue.
      retiredNotes.set(key(source), source);
    } else {
      retiredNotes.delete(key(source));
    }
    const entry = pending.get(key(source));
    if (retainHold && entry !== undefined)
      requeuedHolds.set(key(source), {
        registeredAt: entry.registeredAt,
        order: entry.order,
        priority: entry.priority,
        activityAt: entry.activityAt,
        bestPosition: entry.bestPosition,
        positionImprovedAt: entry.positionImprovedAt,
        admissionProgressAt: entry.admissionProgressAt,
        ...(entry.lastBoundDeferredAt === undefined
          ? {}
          : { lastBoundDeferredAt: entry.lastBoundDeferredAt }),
        loadHoldMs: entry.loadHoldMs,
        checkedAt: entry.checkedAt,
        wasLoaded: entry.wasLoaded,
        ...(entry.observation === undefined ? {} : { observation: entry.observation }),
      });
    pending.delete(key(source));
    for (const [runKey, runSource] of runSources) {
      if (key(runSource) === key(source)) runSources.delete(runKey);
    }
  });
  const register = Effect.fn("RestartPacing.register")(function* (
    source: RestartSource,
    runId?: RunId,
  ) {
    if (superseded.has(key(source))) return;
    const existing = pending.get(key(source));
    if (existing !== undefined) {
      if (existing.runId !== undefined && runId === undefined) return;
      if (source.effectId !== undefined && existing.effectId !== source.effectId) {
        const replacement = { ...existing, effectId: source.effectId, wakeRequested: false };
        // Fresh input can requeue this run and complete its waiting note. The
        // next promotion owns a new effect, but retains its elapsed load hold.
        delete replacement.position;
        delete replacement.waitKey;
        delete replacement.orderWait;
        replacement.retryMs = RECHECK_MS;
        pending.set(key(source), replacement);
      }
      return;
    }
    if (active.has(key(source))) return;
    const previous = [...pending.values()].find((entry) => entry.threadId === source.threadId);
    if (previous !== undefined) {
      // An old durable retry cannot replace the successor that already took its place.
      const ordinal = (id: string) => Number(id.match(/:ordinal:(\d+)$/)?.[1]);
      if (ordinal(source.sourceRunId) < ordinal(previous.sourceRunId)) {
        superseded.add(key(source));
        yield* retire(source);
        return;
      }
      yield* retire(previous);
      superseded.add(key(previous));
      const replacement = {
        ...previous,
        ...source,
        activityAt: previous.activityAt,
        effectId: previous.runId === undefined ? source.effectId : previous.effectId,
        classification: source.classification ?? "continuation",
        wakeRequested: false,
      };
      delete replacement.waitKey;
      delete replacement.orderWait;
      delete replacement.observation;
      pending.set(key(source), replacement);
      yield* Effect.logInfo("restart-pacing.replaced", {
        threadId: source.threadId,
        sourceRunId: source.sourceRunId,
        supersededRunId: previous.sourceRunId,
        queueOrder: previous.order,
        priority: previous.priority,
      });
      return;
    }
    const description = yield* state.describe(source);
    const retained = requeuedHolds.get(key(source));
    const hold =
      retained?.expiredEffectId !== undefined && retained.expiredEffectId !== source.effectId
        ? undefined
        : retained;
    const registeredAt = yield* Clock.currentTimeMillis;
    pending.set(key(source), {
      ...source,
      ...description,
      order: nextOrder++,
      registeredAt,
      bestPosition: Infinity,
      positionImprovedAt: registeredAt,
      admissionProgressAt: registeredAt,
      loadHoldMs: 0,
      checkedAt: yield* Clock.currentTimeMillis,
      wasLoaded: false,
      retryMs: RECHECK_MS,
      ...hold,
      // A fresh effect resets the allowance, but is still the same source run.
      ...(retained?.observation === undefined ? {} : { observation: retained.observation }),
    });
    requeuedHolds.delete(key(source));
  });
  const acquire = Effect.fn("RestartPacing.acquire")(
    function* (source: RestartSource, runId?: RunId) {
      yield* completeRetiredNotes();
      // A queued wake cannot take admission back from the actual provider start.
      if (runId === undefined && active.get(key(source))?.runId !== undefined)
        return yield* new RestartAdmissionSupersededError();
      // Keep the dispatch-to-provider gap reserved; a running turn needs no slot.
      if (active.has(key(source))) {
        if (runId !== undefined) ownRunReservation(source, runId);
        yield* state.status(source, null);
        return 0;
      }
      yield* register(source, runId);
      const owner = pending.get(key(source));
      if (runId === undefined && owner?.runId !== undefined)
        return yield* new RestartAdmissionSupersededError();
      if (owner !== undefined && runId !== undefined) owner.runId = runId;
      if (superseded.has(key(source))) return yield* new RestartAdmissionSupersededError();
      const now = yield* Clock.currentTimeMillis;
      if (pass === undefined || now - pass.at >= PASS_MS) {
        const config = (yield* settingsSnapshot.pipe(
          Effect.mapError((cause) => new RestartPacingStateError({ cause })),
        )).restartPacing;
        const loadScore = load();
        const loadSample = load.snapshot?.();
        pass = {
          at: now,
          config,
          loaded: loadScore > 1,
          loadScore,
          ...(loadSample === undefined ? {} : { loadSample }),
        };
      }
      const { config, loaded } = pass;
      if (activeCheckedAt === undefined || now - activeCheckedAt >= PASS_MS) {
        if (active.size >= config.maxActive && now - lastProgressAt >= STUCK_MS) {
          yield* Effect.logWarning("restart-pacing.stuck", {
            idleMs: now - lastProgressAt,
            maxActive: config.maxActive,
            holders: [...active.values()].map((holder) => ({
              ...holder.source,
              dispatching: holder.dispatching,
              ageMs: now - holder.admittedAt,
            })),
          });
          for (const holder of active.values()) releaseReservation(holder.source, now, true);
        }
        for (const running of active.values()) {
          if (now - running.admittedAt >= STUCK_MS) {
            yield* Effect.logWarning("restart-pacing.reservation-expired", {
              ...running.source,
              dispatching: running.dispatching,
              ageMs: now - running.admittedAt,
            });
            releaseReservation(running.source, now, true);
            continue;
          }
          if (running.dispatching && now - running.admittedAt < DISPATCH_GRACE_MS) continue;
          const stillStarting = yield* state.active(running.source, running.runId).pipe(
            Effect.catch(() =>
              Effect.logWarning("restart-pacing.reservation-read-failed", {
                ...running.source,
                ageMs: now - running.admittedAt,
              }).pipe(Effect.andThen(Effect.succeed(true))),
            ),
          );
          if (!stillStarting) {
            if (running.dispatching) {
              yield* Effect.logWarning("restart-pacing.reservation-reclaimed", {
                ...running.source,
                ageMs: now - running.admittedAt,
              });
            }
            releaseReservation(running.source, now, true);
          }
        }
        activeCheckedAt = now;
      }
      const queue = [...pending.values()];
      const spacing =
        lastStartAt === undefined ? 0 : Math.max(0, config.spacingMs - (now - lastStartAt));
      updateLoadHolds(now, loaded);
      // A new load-held arrival must not starve waiters whose load budget is spent.
      queue.sort(
        (a, b) =>
          Number(loaded && a.loadHoldMs < MAX_LOAD_HOLD_MS) -
            Number(loaded && b.loadHoldMs < MAX_LOAD_HOLD_MS) ||
          a.priority - b.priority ||
          a.order - b.order,
      );
      // Clearing a settled effect's note reads its projection only on removal;
      // live waiters need no projection reads to retry the gate.
      while (queue.length > 0 && !(yield* state.pending(queue[0]!))) {
        const stale = queue[0]!;
        queue.shift();
        // Preserve the replacement's note and budget without blocking other starts.
        yield* retire(stale, true);
      }
      const entry = pending.get(key(source));
      if (entry === undefined) return yield* new RestartAdmissionSupersededError();
      entry.wakeRequested = false;
      const position = queue.indexOf(entry) + 1;
      observeProgress(queue, yield* Clock.currentTimeMillis);
      const absoluteDeadline = entry.registeredAt + RESTART_ADMISSION_ABSOLUTE_TIMEOUT_MS;
      const progressDeadline = noProgressDeadline(entry);
      const admissionDeadline = Math.min(absoluteDeadline, progressDeadline);
      const lastAdmissionAgoMs = lastStartAt === undefined ? null : now - lastStartAt;
      const checkBound = Effect.gen(function* () {
        const checkedAt = yield* Clock.currentTimeMillis;
        const rule =
          checkedAt >= absoluteDeadline
            ? "absolute_backstop"
            : checkedAt >= progressDeadline
              ? "no_progress"
              : undefined;
        if (rule === undefined) return checkedAt;
        const admission = {
          queuedAtMs: entry.registeredAt,
          waitedMs: checkedAt - entry.registeredAt,
          positionAtFailure: position,
          totalAtFailure: queue.length,
          rule,
        } satisfies OrchestrationV2RestartAdmissionFailure;
        yield* Effect.logWarning("restart-pacing.bound_failed", {
          threadId: source.threadId,
          sourceRunId: source.sourceRunId,
          queuedAtMs: entry.registeredAt,
          waitedMs: checkedAt - entry.registeredAt,
          rule,
          lastAdmissionAgoMs: lastStartAt === undefined ? null : checkedAt - lastStartAt,
          admissionProgressAgoMs: checkedAt - entry.admissionProgressAt,
          positionImprovedAgoMs: checkedAt - entry.positionImprovedAt,
          total: queue.length,
          active: active.size,
          position,
          hasSuccessor: yield* state.hasSuccessor(source, runId),
        });
        yield* recordAdmission(source, entry.observation, {
          at: checkedAt,
          runId,
          queuedAtMs: entry.registeredAt,
          position,
          total: queue.length,
          active: active.size,
          maxActive: config.maxActive,
          loaded,
          rule,
        });
        yield* state.status(source, null);
        pending.delete(key(source));
        // A failed expiry commit retries this effect immediately; a new resume
        // gets its own allowance instead of inheriting the retired registration.
        requeuedHolds.set(key(source), {
          registeredAt: entry.registeredAt,
          bestPosition: entry.bestPosition,
          positionImprovedAt: entry.positionImprovedAt,
          admissionProgressAt: entry.admissionProgressAt,
          ...(entry.lastBoundDeferredAt === undefined
            ? {}
            : { lastBoundDeferredAt: entry.lastBoundDeferredAt }),
          loadHoldMs: entry.loadHoldMs,
          checkedAt: entry.checkedAt,
          wasLoaded: entry.wasLoaded,
          ...(entry.observation === undefined ? {} : { observation: entry.observation }),
          ...(source.effectId === undefined ? {} : { expiredEffectId: source.effectId }),
        });
        for (const [runKey, runSource] of runSources) {
          if (key(runSource) === key(source)) runSources.delete(runKey);
        }
        return yield* new RestartAdmissionTimeoutError({
          deadline: DateTime.makeUnsafe(admissionDeadline),
          admission,
        });
      });
      yield* checkBound;
      if (
        now - entry.registeredAt >= RESTART_ADMISSION_TIMEOUT_MS &&
        (entry.lastBoundDeferredAt === undefined ||
          now - entry.lastBoundDeferredAt >= BOUND_DEFERRED_LOG_MS)
      ) {
        entry.lastBoundDeferredAt = now;
        yield* Effect.logWarning("restart-pacing.bound_deferred", {
          threadId: source.threadId,
          sourceRunId: source.sourceRunId,
          queuedAtMs: entry.registeredAt,
          waitedMs: now - entry.registeredAt,
          position,
          total: queue.length,
          active: active.size,
          lastAdmissionAgoMs,
          positionImprovedAgoMs: now - entry.positionImprovedAt,
        });
      }
      if (position === 0) return RECHECK_MS;
      // Async persistence lets claims reach the gate out of priority order.
      // Retry promptly when that head advances, but back off if it stays stuck.
      if (
        position !== 1 &&
        active.size < config.maxActive &&
        spacing === 0 &&
        (!loaded || entry.loadHoldMs >= MAX_LOAD_HOLD_MS)
      ) {
        const head = key(queue[0]!);
        const retryMs =
          entry.orderWait?.head === head
            ? Math.min(MAX_ORDER_RECHECK_MS, entry.orderWait.retryMs * 2)
            : 1;
        entry.orderWait = { head, retryMs };
        return retryMs;
      }
      if (
        position !== 1 ||
        active.size >= config.maxActive ||
        spacing > 0 ||
        (loaded && entry.loadHoldMs < MAX_LOAD_HOLD_MS)
      ) {
        delete entry.orderWait;
        const wait = {
          total: queue.length,
          active: active.size,
          maxActive: config.maxActive,
          spacingMs: spacing,
          loadHoldElapsedMs: entry.loadHoldMs,
          loadHoldRemainingMs: loaded ? Math.max(0, MAX_LOAD_HOLD_MS - entry.loadHoldMs) : 0,
        };
        // Publish gate transitions, not every durable retry tick.
        const waitKey = [
          position,
          wait.total,
          wait.active,
          wait.maxActive,
          spacing > 0,
          wait.loadHoldRemainingMs > 0,
        ].join(":");
        if (entry.waitKey !== waitKey) {
          yield* state.status(source, position, wait);
          entry.position = position;
          entry.waitKey = waitKey;
          yield* Effect.logInfo("restart-pacing.waiting", {
            threadId: source.threadId,
            sourceRunId: source.sourceRunId,
            position,
            loaded,
            classification: source.classification ?? "continuation",
            priority: entry.priority,
            queueOrder: entry.order,
            queuedAtMs: entry.registeredAt,
            waitedMs: now - entry.registeredAt,
            lastAdmissionAgoMs,
            ...(loaded ? { loadScore: pass.loadScore, loadThreshold: 1, ...pass.loadSample } : {}),
            reasons: [
              ...(position > 1 ? ["queue"] : []),
              ...(active.size >= config.maxActive ? ["maxActive"] : []),
              ...(spacing > 0 ? ["spacing"] : []),
              ...(wait.loadHoldRemainingMs > 0 ? ["load"] : []),
            ],
            ...wait,
          });
        }
        const remainingHold = MAX_LOAD_HOLD_MS - entry.loadHoldMs;
        const retryMs = Math.min(
          loaded && remainingHold > 0 ? Math.min(entry.retryMs, remainingHold) : entry.retryMs,
          admissionDeadline - now,
        );
        entry.retryMs = Math.min(MAX_RECHECK_MS, retryMs * 2);
        return spacing > 0 &&
          (!loaded || remainingHold <= 0) &&
          position === 1 &&
          active.size < config.maxActive
          ? Math.min(retryMs, spacing)
          : retryMs;
      }
      if (runId !== undefined) {
        // Classification is cached while waiting. Revalidate after admission
        // becomes possible so cancelled/requeued starts don't claim a slot.
        const current = yield* state.sourceForRun(source.threadId, runId);
        if (current === undefined) {
          yield* state.status(source, null);
          pending.delete(key(source));
          return 0;
        }
      }
      yield* state.status(source, null);
      // Persistence can outlast either deadline while admission holds the mutex.
      const admittedAt = yield* checkBound;
      active.set(key(source), {
        source,
        dispatching: true,
        admittedAt,
        hold: {
          // Admission ends this clock; retries retain only spent load credit.
          loadHoldMs: entry.loadHoldMs,
          checkedAt: admittedAt,
          wasLoaded: loaded,
          ...(entry.observation === undefined ? {} : { observation: entry.observation }),
        },
      });
      pending.delete(key(source));
      observeProgress(
        queue.filter((waiting) => waiting !== entry),
        admittedAt,
        true,
      );
      // Pruned effects retain their queue age until a replacement registers.
      // Admissions elsewhere still count while that replacement is pending.
      for (const hold of requeuedHolds.values()) {
        if (
          hold.admissionProgressAt !== undefined &&
          hold.positionImprovedAt !== undefined &&
          admittedAt <
            Math.min(hold.admissionProgressAt, hold.positionImprovedAt) +
              RESTART_ADMISSION_TIMEOUT_MS
        )
          hold.admissionProgressAt = admittedAt;
      }
      lastStartAt = admittedAt;
      lastProgressAt = admittedAt;
      if (runId !== undefined) ownRunReservation(source, runId);
      yield* recordAdmission(source, entry.observation, {
        at: admittedAt,
        runId,
        queuedAtMs: entry.registeredAt,
        position,
        total: queue.length,
        active: active.size,
        maxActive: config.maxActive,
        loaded,
      });
      yield* Effect.logInfo("restart-pacing.admitted", {
        threadId: source.threadId,
        sourceRunId: source.sourceRunId,
        active: active.size,
        loadHoldMs: entry.loadHoldMs,
        queuedAtMs: entry.registeredAt,
        waitedMs: admittedAt - entry.registeredAt,
        headIdleMs: Math.max(0, admittedAt - (entry.readyAt ?? now)),
        priority: entry.priority,
        queueOrder: entry.order,
        classification: source.classification ?? "continuation",
      });
      return 0;
    },
    (effect) => mutex.withPermits(1)(effect.pipe(Effect.ensuring(queueChanged))),
  );
  const dispatched = Effect.fn("RestartPacing.dispatched")(
    function* (source: RestartSource, declined = false) {
      const reservation = active.get(key(source));
      if (declined && reservation === undefined) {
        const entry = pending.get(key(source));
        if (entry !== undefined && entry.effectId !== source.effectId) return;
        if (!(yield* state.status(source, null))) return;
        pending.delete(key(source));
        requeuedHolds.delete(key(source));
        for (const [runKey, cached] of runSources) {
          if (key(cached) === key(source)) runSources.delete(runKey);
        }
      }
      if (reservation === undefined || reservation.source.effectId !== source.effectId) return;
      // Dispatch has finished even if its settlement read temporarily fails.
      // Later admissions must be able to re-check this reservation.
      reservation.dispatching = false;
      // Successful per-holder progress must not make a burst rescan every
      // earlier reservation. A failed check still needs a fresh global pass.
      const stillStarting = yield* state.active(source, reservation.runId).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            activeCheckedAt = undefined;
          }),
        ),
      );
      if (!stillStarting) {
        releaseReservation(source, yield* Clock.currentTimeMillis);
      }
    },
    (effect) => mutex.withPermits(1)(effect.pipe(Effect.ensuring(queueChanged))),
  );
  const acquireRun = Effect.fn("RestartPacing.acquireRun")(function* (
    threadId: ThreadId,
    runId: RunId,
    effectId?: string,
  ) {
    const runKey = `${threadId}:${runId}`;
    // Queue recovery can admit this run itself even when its persisted
    // continuation marker still names the superseded predecessor.
    let source =
      runSources.get(runKey) ??
      active.get(runKey)?.source ??
      pending.get(runKey) ??
      (yield* state.sourceForRun(threadId, runId));
    if (source === undefined) return 0;
    if (superseded.has(key(source))) {
      const current = yield* state.sourceForRun(threadId, runId);
      if (current === undefined) return 0;
      // Supersession retires a wake, not the input of a promoted run. Charge its
      // start to the thread's replacement entry, or revalidate a new admission.
      source = [...pending.values()].find((entry) => entry.threadId === threadId) ??
        [...active.values()].find((entry) => entry.source.threadId === threadId)?.source ?? {
          ...current,
          sourceRunId: runId,
        };
      superseded.delete(key(source));
    }
    runSources.set(runKey, { ...source, effectId, admitted: false });
    const delay = yield* acquire({ ...source, effectId }, runId);
    if (delay === 0 && !runSources.get(runKey)?.admitted) runSources.delete(runKey);
    return delay;
  });
  // Durable retries can already be asleep for a minute when they become head.
  // Wake only that effect; never hold a provider worker while waiting for spacing.
  const wakeHead = Effect.fn("RestartPacing.wakeHead")(
    function* () {
      changed = yield* Deferred.make<void>();
      yield* completeRetiredNotes();
      const next = (delay?: number) => ({ delay, signal: changed });
      if (pass === undefined || pending.size === 0)
        return next(retiredNotes.size > 0 ? PASS_MS : undefined);
      const now = yield* Clock.currentTimeMillis;
      const { config, loaded } = pass;
      const queue = orderedQueue(now, loaded);
      while (queue.length > 0 && !(yield* state.pending(queue[0]!))) {
        yield* retire(queue.shift()!, true);
      }
      observeProgress(queue, yield* Clock.currentTimeMillis);
      const head = queue[0];
      if (head === undefined) return next(PASS_MS);
      const spacingAt =
        lastStartAt === undefined ? head.registeredAt : lastStartAt + config.spacingMs;
      const blocked =
        active.size >= config.maxActive ||
        (loaded &&
          head.loadHoldMs + (head.wasLoaded ? Math.max(0, now - head.checkedAt) : 0) <
            MAX_LOAD_HOLD_MS);
      for (const entry of queue)
        if (entry !== head || active.size >= config.maxActive) delete entry.readyAt;
      if (blocked) return next(PASS_MS);
      head.readyAt ??= Math.max(now, spacingAt);
      if (now < spacingAt) return next(spacingAt - now);
      if (head.wakeRequested || head.effectId === undefined) return next(PASS_MS);
      head.wakeRequested = yield* state.wake(head);
      // A claim may still be unwinding into its durable retry. Retry only that
      // race; sleeping heads are woken once, at their spacing deadline.
      return next(head.wakeRequested ? PASS_MS : 100);
    },
    (effect) => mutex.withPermits(1)(effect),
  );
  yield* Effect.gen(function* () {
    const next = yield* wakeHead();
    const notified = Deferred.await(next.signal);
    yield* next.delay === undefined
      ? notified
      : Effect.raceFirst(notified, Effect.sleep(next.delay));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("restart-pacing.wake-failed", { cause }).pipe(
        Effect.andThen(Effect.sleep(1000)),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  return RestartPacing.of({
    settingsSnapshot,
    register: (source) =>
      mutex.withPermits(1)(register(source).pipe(Effect.ensuring(queueChanged))),
    acquire,
    acquireRun,
    dispatched,
    release,
    releaseRun,
  });
});
export const layer = Layer.effect(RestartPacing, make);
