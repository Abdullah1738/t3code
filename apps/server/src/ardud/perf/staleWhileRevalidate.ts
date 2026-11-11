import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * ardud: a per-service cache for slow host discovery (tailscale status, the
 * Serve self-probe, sshd checks) that every WebSocket connect used to rerun.
 *
 * - The first read waits for one shared computation; concurrent reads join it.
 * - A fresh value (younger than `ttlMs`) is returned at once.
 * - A stale value is returned at once while one background refresh runs.
 * - The computation runs detached, so a caller's timeout or disconnect never
 *   cancels work other connects are waiting on.
 * - A failed or interrupted computation is not cached; the next read retries.
 *
 * On 11 Nov 2026 `ws.loadServerConfig` took a median 7.5 s per connect, most of
 * it spawning `tailscale status` and probing this server over Tailscale HTTPS,
 * which ate the clients' 15 s connection-setup budget.
 */
export const makeStaleWhileRevalidate = <A, R>(
  compute: Effect.Effect<A, never, R>,
  ttlMs: number,
): Effect.Effect<A, never, R> => {
  let latest: { readonly value: A; readonly at: number } | undefined;
  let inFlight: Deferred.Deferred<A> | undefined;

  const start = Effect.gen(function* () {
    const existing = inFlight;
    if (existing !== undefined) return existing;
    const result = yield* Deferred.make<A>();
    inFlight = result;
    yield* compute.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (inFlight === result) inFlight = undefined;
          if (Exit.isSuccess(exit)) {
            latest = { value: exit.value, at: yield* Clock.currentTimeMillis };
            yield* Deferred.succeed(result, exit.value);
          } else {
            yield* Deferred.failCause(result, exit.cause);
          }
        }),
      ),
      Effect.forkDetach,
    );
    return result;
  });

  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = latest;
    if (cached !== undefined) {
      if (now - cached.at >= ttlMs) yield* start;
      return cached.value;
    }
    return yield* Deferred.await(yield* start);
  });
};
