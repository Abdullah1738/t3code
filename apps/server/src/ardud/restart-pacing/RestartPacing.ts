import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as ServerSettings from "../../serverSettings.ts";
import * as RestartPacingState from "./RestartPacingState.ts";
import { makeRestartLoad } from "./RestartLoad.ts";
import type {
  RunId,
  ThreadId,
  ServerSettings as Settings,
  ServerSettingsError,
} from "@t3tools/contracts";
import { RestartPacingStateError, type RestartSource } from "./RestartPacingState.ts";

const RECHECK_MS = 15_000;
const MAX_RECHECK_MS = 60_000;
const PASS_MS = 10_000;
const MAX_LOAD_HOLD_MS = 20 * 60_000;
// Allow the full load hold plus ten minutes for admission, but never let an
// old restart registration silently block a new resume for hours.
export const RESTART_ADMISSION_TIMEOUT_MS = 30 * 60_000;
export class RestartAdmissionTimeoutError extends Schema.TaggedError<RestartAdmissionTimeoutError>()(
  "RestartAdmissionTimeoutError",
  { deadline: Schema.DateTimeUtc },
) {}
const DISPATCH_GRACE_MS = 2 * 60_000;
const STUCK_MS = 10 * 60_000;

type LoadHold = {
  loadHoldMs: number;
  checkedAt: number;
  wasLoaded: boolean;
};
type WaitingHold = LoadHold & {
  registeredAt?: number;
  expiredEffectId?: string;
};

export class RestartLoad extends Context.Reference<() => number>("t3/ardud/RestartLoad", {
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
    ) => Effect.Effect<number, RestartPacingStateError | RestartAdmissionTimeoutError>;
    readonly register: (source: RestartSource) => Effect.Effect<void, RestartPacingStateError>;
    readonly acquire: (
      source: RestartSource,
    ) => Effect.Effect<number, RestartPacingStateError | RestartAdmissionTimeoutError>;
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
  // Keep CPU intervals short even when durable retries back off to a minute.
  yield* Effect.sleep("10 seconds").pipe(
    Effect.andThen(Effect.sync(load)),
    Effect.forever,
    Effect.forkScoped,
  );
  const mutex = yield* Semaphore.make(1);
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
    RestartSource & {
      registeredAt: number;
      priority: number;
      activityAt: number;
      loadHoldMs: number;
      checkedAt: number;
      wasLoaded: boolean;
      retryMs: number;
      position?: number;
      waitKey?: string;
    }
  >();
  // A requeued run can outlive its settled start effect. Keep its load budget
  // across pruning until a replacement effect registers it again.
  const requeuedHolds = new Map<string, WaitingHold>();
  const active = new Map<
    string,
    { source: RestartSource; dispatching: boolean; admittedAt: number; hold: LoadHold }
  >();
  let lastStartAt: number | undefined;
  let lastProgressAt = 0;
  let pass: { at: number; config: Settings["restartPacing"]; loaded: boolean } | undefined;
  let activeCheckedAt: number | undefined;
  const runSources = new Map<string, RestartSource & { admitted?: boolean; hold?: LoadHold }>();
  const key = (source: RestartSource) => `${source.threadId}:${source.sourceRunId}`;
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
    (effect) => mutex.withPermits(1)(effect),
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
      runSources.delete(runKey);
    },
    (effect) => mutex.withPermits(1)(effect),
  );
  // Keep allocation/transfer and its finalizer metadata in the same mutex turn.
  const ownRunReservation = (source: RestartSource, runId: RunId) => {
    const reservation = active.get(key(source));
    if (reservation === undefined) return;
    reservation.source = source;
    reservation.dispatching = false;
    runSources.set(`${source.threadId}:${runId}`, {
      ...source,
      admitted: true,
      hold: reservation.hold,
    });
    activeCheckedAt = undefined;
  };
  const register = Effect.fn("RestartPacing.register")(function* (source: RestartSource) {
    const existing = pending.get(key(source));
    if (existing !== undefined) {
      if (source.effectId !== undefined && existing.effectId !== source.effectId) {
        const replacement = { ...existing, effectId: source.effectId };
        // Fresh input can requeue this run and complete its waiting note. The
        // next promotion owns a new effect, but retains its elapsed load hold.
        delete replacement.position;
        delete replacement.waitKey;
        replacement.retryMs = RECHECK_MS;
        pending.set(key(source), replacement);
      }
      return;
    }
    if (active.has(key(source))) return;
    const description = yield* state.describe(source);
    const retained = requeuedHolds.get(key(source));
    const hold =
      retained?.expiredEffectId !== undefined && retained.expiredEffectId !== source.effectId
        ? undefined
        : retained;
    pending.set(key(source), {
      ...source,
      ...description,
      registeredAt: yield* Clock.currentTimeMillis,
      loadHoldMs: 0,
      checkedAt: yield* Clock.currentTimeMillis,
      wasLoaded: false,
      retryMs: RECHECK_MS,
      ...hold,
    });
    requeuedHolds.delete(key(source));
  });
  const acquire = Effect.fn("RestartPacing.acquire")(
    function* (source: RestartSource, runId?: RunId) {
      // Keep the dispatch-to-provider gap reserved; a running turn needs no slot.
      if (active.has(key(source))) {
        if (runId !== undefined) ownRunReservation(source, runId);
        yield* state.status(source, null);
        return 0;
      }
      yield* register(source);
      const now = yield* Clock.currentTimeMillis;
      if (pass === undefined || now - pass.at >= PASS_MS) {
        const config = (yield* settingsSnapshot.pipe(
          Effect.mapError((cause) => new RestartPacingStateError({ cause })),
        )).restartPacing;
        pass = { at: now, config, loaded: load() > 1 };
      }
      if (activeCheckedAt === undefined || now - activeCheckedAt >= PASS_MS) {
        if (active.size >= pass.config.maxActive && now - lastProgressAt >= STUCK_MS) {
          yield* Effect.logWarning("restart-pacing.stuck", {
            idleMs: now - lastProgressAt,
            maxActive: pass.config.maxActive,
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
          const stillStarting = yield* state.active(running.source).pipe(
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
      const { config, loaded } = pass;
      const queue = [...pending.values()];
      const spacing =
        lastStartAt === undefined ? 0 : Math.max(0, config.spacingMs - (now - lastStartAt));
      for (const entry of queue) {
        if (entry.wasLoaded) entry.loadHoldMs += Math.max(0, now - entry.checkedAt);
        entry.checkedAt = now;
        entry.wasLoaded = loaded;
      }
      // A new load-held arrival must not starve waiters whose load budget is spent.
      queue.sort(
        (a, b) =>
          Number(loaded && a.loadHoldMs < MAX_LOAD_HOLD_MS) -
            Number(loaded && b.loadHoldMs < MAX_LOAD_HOLD_MS) ||
          a.priority - b.priority ||
          b.activityAt - a.activityAt ||
          key(a).localeCompare(key(b)),
      );
      // Clearing a settled effect's note reads its projection only on removal;
      // live waiters need no projection reads to retry the gate.
      while (queue.length > 0 && !(yield* state.pending(queue[0]!))) {
        const stale = queue[0]!;
        queue.shift();
        // Preserve the replacement's note and budget without blocking other starts.
        if (!(yield* state.status(stale, null))) continue;
        requeuedHolds.set(key(stale), {
          registeredAt: stale.registeredAt,
          loadHoldMs: stale.loadHoldMs,
          checkedAt: stale.checkedAt,
          wasLoaded: stale.wasLoaded,
        });
        pending.delete(key(stale));
        for (const [runKey, runSource] of runSources) {
          if (key(runSource) === key(stale)) runSources.delete(runKey);
        }
      }
      const entry = pending.get(key(source));
      if (entry === undefined) return 0;
      const position = queue.indexOf(entry) + 1;
      if (now - entry.registeredAt >= RESTART_ADMISSION_TIMEOUT_MS) {
        yield* state.status(source, null);
        pending.delete(key(source));
        // A failed expiry commit retries this effect immediately; a new resume
        // gets its own allowance instead of inheriting the retired registration.
        requeuedHolds.set(key(source), {
          registeredAt: entry.registeredAt,
          loadHoldMs: entry.loadHoldMs,
          checkedAt: entry.checkedAt,
          wasLoaded: entry.wasLoaded,
          ...(source.effectId === undefined ? {} : { expiredEffectId: source.effectId }),
        });
        for (const [runKey, runSource] of runSources) {
          if (key(runSource) === key(source)) runSources.delete(runKey);
        }
        return yield* new RestartAdmissionTimeoutError({
          deadline: DateTime.makeUnsafe(entry.registeredAt + RESTART_ADMISSION_TIMEOUT_MS),
        });
      }
      if (position === 0) return RECHECK_MS;
      if (
        position !== 1 ||
        active.size >= config.maxActive ||
        spacing > 0 ||
        (loaded && entry.loadHoldMs < MAX_LOAD_HOLD_MS)
      ) {
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
          RESTART_ADMISSION_TIMEOUT_MS - (now - entry.registeredAt),
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
      active.set(key(source), {
        source,
        dispatching: true,
        admittedAt: now,
        hold: {
          // Admission ends this clock; retries retain only spent load credit.
          loadHoldMs: entry.loadHoldMs,
          checkedAt: now,
          wasLoaded: loaded,
        },
      });
      pending.delete(key(source));
      lastStartAt = now;
      lastProgressAt = now;
      if (runId !== undefined) ownRunReservation(source, runId);
      yield* Effect.logInfo("restart-pacing.admitted", {
        threadId: source.threadId,
        sourceRunId: source.sourceRunId,
        active: active.size,
        loadHoldMs: entry.loadHoldMs,
        classification: source.classification ?? "continuation",
      });
      return 0;
    },
    (effect) => mutex.withPermits(1)(effect),
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
      activeCheckedAt = undefined;
      if (!(yield* state.active(source))) {
        releaseReservation(source, yield* Clock.currentTimeMillis);
      }
    },
    (effect) => mutex.withPermits(1)(effect),
  );
  const acquireRun = Effect.fn("RestartPacing.acquireRun")(function* (
    threadId: ThreadId,
    runId: RunId,
    effectId?: string,
  ) {
    const runKey = `${threadId}:${runId}`;
    const source = runSources.get(runKey) ?? (yield* state.sourceForRun(threadId, runId));
    if (source === undefined) return 0;
    runSources.set(runKey, { ...source, effectId, admitted: false });
    const delay = yield* acquire({ ...source, effectId }, runId);
    if (delay === 0 && !runSources.get(runKey)?.admitted) runSources.delete(runKey);
    return delay;
  });
  return RestartPacing.of({
    settingsSnapshot,
    register,
    acquire,
    acquireRun,
    dispatched,
    release,
    releaseRun,
  });
});
export const layer = Layer.effect(RestartPacing, make);
