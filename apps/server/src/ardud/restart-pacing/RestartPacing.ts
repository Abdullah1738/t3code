// @effect-diagnostics nodeBuiltinImport:off -- The production load source reads host load per core.
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as ServerSettings from "../../serverSettings.ts";
import * as RestartPacingState from "./RestartPacingState.ts";
import type { RunId, ThreadId } from "@t3tools/contracts";
import { RestartPacingStateError, type RestartSource } from "./RestartPacingState.ts";

const RECHECK_MS = 15_000;
const MAX_LOAD_HOLD_MS = 20 * 60_000;

export class RestartLoad extends Context.Reference<() => number>("t3/ardud/RestartLoad", {
  defaultValue: () => () => NodeOS.loadavg()[0]! / Math.max(1, NodeOS.cpus().length),
}) {}

export class RestartPacing extends Context.Service<
  RestartPacing,
  {
    readonly acquireRun: (
      threadId: ThreadId,
      runId: RunId,
      effectId?: string,
    ) => Effect.Effect<number, RestartPacingStateError>;
    readonly register: (source: RestartSource) => Effect.Effect<void, RestartPacingStateError>;
    readonly acquire: (source: RestartSource) => Effect.Effect<number, RestartPacingStateError>;
    readonly dispatched: (source: RestartSource) => Effect.Effect<void, RestartPacingStateError>;
  }
>()("t3/ardud/restart-pacing/RestartPacing") {}

const make = Effect.gen(function* () {
  const state = yield* RestartPacingState.RestartPacingState;
  const settings = yield* ServerSettings.ServerSettingsService;
  const load = yield* RestartLoad;
  const mutex = yield* Semaphore.make(1);
  const pending = new Map<
    string,
    RestartSource & {
      priority: number;
      activityAt: number;
      loadHoldMs: number;
      checkedAt: number;
      wasLoaded: boolean;
      position?: number;
    }
  >();
  // A requeued run can outlive its settled start effect. Keep its load budget
  // across pruning until a replacement effect registers it again.
  const requeuedHolds = new Map<
    string,
    { loadHoldMs: number; checkedAt: number; wasLoaded: boolean }
  >();
  const active = new Map<string, { source: RestartSource; dispatching: boolean }>();
  let lastStartAt: number | undefined;
  let released = false;
  const key = (source: RestartSource) => `${source.threadId}:${source.sourceRunId}`;
  const register = Effect.fn("RestartPacing.register")(function* (source: RestartSource) {
    const existing = pending.get(key(source));
    if (existing !== undefined) {
      if (source.effectId !== undefined && existing.effectId !== source.effectId) {
        const replacement = { ...existing, effectId: source.effectId };
        // Fresh input can requeue this run and complete its waiting note. The
        // next promotion owns a new effect, but retains its elapsed load hold.
        delete replacement.position;
        pending.set(key(source), replacement);
      }
      return;
    }
    if (active.has(key(source))) return;
    const description = yield* state.describe(source);
    pending.set(key(source), {
      ...source,
      ...description,
      loadHoldMs: 0,
      checkedAt: yield* Clock.currentTimeMillis,
      wasLoaded: false,
      ...requeuedHolds.get(key(source)),
    });
    requeuedHolds.delete(key(source));
  });
  const acquire = Effect.fn("RestartPacing.acquire")(
    function* (source: RestartSource) {
      // Reservations cover the dispatch-to-provider gap and remain held after the
      // outbox claim succeeds. Durable turn state, not claim completion, frees them.
      if (active.has(key(source))) {
        yield* state.status(source, null);
        return 0;
      }
      yield* register(source);
      for (const [id, running] of active) {
        if (!running.dispatching && !(yield* state.active(running.source))) {
          active.delete(id);
          released = true;
        }
      }
      const config = (yield* settings.getSettings.pipe(
        Effect.mapError((cause) => new RestartPacingStateError({ cause })),
      )).restartPacing;
      const now = yield* Clock.currentTimeMillis;
      const queue = [...pending.values()].sort(
        (a, b) =>
          a.priority - b.priority || b.activityAt - a.activityAt || key(a).localeCompare(key(b)),
      );
      while (queue.length > 0 && !(yield* state.pending(queue[0]!))) {
        const stale = queue[0]!;
        // Keep cleanup ownership while an unclaimed replacement owns the note.
        if (!(yield* state.status(stale, null))) break;
        queue.shift();
        requeuedHolds.set(key(stale), {
          loadHoldMs: stale.loadHoldMs,
          checkedAt: stale.checkedAt,
          wasLoaded: stale.wasLoaded,
        });
        pending.delete(key(stale));
      }
      const entry = pending.get(key(source));
      if (entry === undefined) return 0;
      const position = queue.indexOf(entry) + 1;
      const loaded = load() >= config.loadHigh;
      if (entry.wasLoaded) entry.loadHoldMs += Math.max(0, now - entry.checkedAt);
      entry.checkedAt = now;
      entry.wasLoaded = loaded;
      const spacing =
        lastStartAt === undefined || released
          ? 0
          : Math.max(0, config.spacingMs - (now - lastStartAt));
      if (
        position !== 1 ||
        active.size >= config.maxActive ||
        spacing > 0 ||
        (loaded && entry.loadHoldMs < MAX_LOAD_HOLD_MS)
      ) {
        if (entry.position !== position) {
          yield* state.status(source, position);
          entry.position = position;
          yield* Effect.logInfo("restart-pacing.waiting", {
            threadId: source.threadId,
            sourceRunId: source.sourceRunId,
            position,
            active: active.size,
            loaded,
          });
        }
        return spacing > 0 && !loaded && position === 1 && active.size < config.maxActive
          ? Math.min(RECHECK_MS, spacing)
          : RECHECK_MS;
      }
      yield* state.status(source, null);
      active.set(key(source), { source, dispatching: true });
      pending.delete(key(source));
      lastStartAt = now;
      released = false;
      yield* Effect.logInfo("restart-pacing.admitted", {
        threadId: source.threadId,
        sourceRunId: source.sourceRunId,
        active: active.size,
        loadHoldMs: entry.loadHoldMs,
      });
      return 0;
    },
    (effect) => mutex.withPermits(1)(effect),
  );
  const dispatched = Effect.fn("RestartPacing.dispatched")(
    function* (source: RestartSource) {
      const reservation = active.get(key(source));
      if (reservation === undefined) return;
      // Dispatch has finished even if its settlement read temporarily fails.
      // Later admissions must be able to re-check this reservation.
      reservation.dispatching = false;
      if (!(yield* state.active(source))) {
        active.delete(key(source));
        pending.delete(key(source));
        released = true;
      }
    },
    (effect) => mutex.withPermits(1)(effect),
  );
  const acquireRun = Effect.fn("RestartPacing.acquireRun")(function* (
    threadId: ThreadId,
    runId: RunId,
    effectId?: string,
  ) {
    const source = yield* state.sourceForRun(threadId, runId);
    if (source === undefined) return 0;
    const delay = yield* acquire({ ...source, effectId });
    if (delay === 0) {
      // This admission already has a durable run. Continuation dispatches keep
      // their reservation opaque until their transaction has committed instead.
      const reservation = active.get(key(source));
      if (reservation !== undefined) reservation.dispatching = false;
    }
    return delay;
  });
  return RestartPacing.of({ register, acquire, acquireRun, dispatched });
});
export const layer = Layer.effect(RestartPacing, make);
