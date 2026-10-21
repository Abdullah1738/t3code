/**
 * Retrying an OpenCode health check that failed.
 *
 * Health checks do not run on an interval, so a check that hit a busy or
 * restarting server (T3 and OpenCode booting together, an OpenCode upgrade)
 * left the provider in error until someone pressed Refresh in Settings, and
 * every turn on it was refused meanwhile.
 *
 * @module provider/opencode/ardud/probeRetry
 */
import type { ServerProvider } from "@t3tools/contracts";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

/** A busy server usually answers within seconds. */
const FIRST_RETRY_MS = 5_000;
/** A server that stays down for minutes is not probed more often than this. */
const MAX_RETRY_MS = 120_000;
/** Still failing after this needs a person; the next failed check starts over. */
const GIVE_UP_AFTER_MS = 30 * 60_000;

const needsRetry = (snapshot: ServerProvider) => snapshot.enabled && snapshot.status === "error";

/**
 * `observe` sees every check result. `start` retries after a failed one with
 * backoff until the provider stops reporting an error, whoever's check fixed
 * it. Each retry is an ordinary `refresh`, so it never holds the refresh
 * semaphore across the wait.
 */
export const makeOpenCodeProbeRetry = Effect.fn("OpenCodeProbeRetry.make")(function* () {
  const failed = yield* Queue.sliding<void>(1);

  const observe = (snapshot: ServerProvider) =>
    needsRetry(snapshot) ? Queue.offer(failed, undefined).pipe(Effect.asVoid) : Effect.void;

  const start = (provider: Pick<ManagedServerProvider, "getSnapshot" | "refresh">) =>
    Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(failed);
        const startedAt = yield* Clock.currentTimeMillis;
        let delay = FIRST_RETRY_MS;
        while (true) {
          // The failed result is observed before it is applied, so the
          // snapshot is only read after the first wait.
          yield* Effect.sleep(delay);
          if (!needsRetry(yield* provider.getSnapshot)) return;
          const result = yield* Effect.exit(provider.refresh);
          if (result._tag === "Success" && !needsRetry(result.value)) return;
          // This retry's own failure is handled here; leaving it queued would
          // start another round as soon as this one gives up.
          yield* Queue.clear(failed);
          // Checked after the attempt so a host that slept past the deadline
          // still gets one try when it wakes.
          if ((yield* Clock.currentTimeMillis) - startedAt >= GIVE_UP_AFTER_MS) {
            yield* Effect.logWarning(
              "OpenCode health check still failing after 30 minutes; retrying after the next failed check",
            );
            return;
          }
          delay = Math.min(delay * 2, MAX_RETRY_MS);
        }
      }),
    ).pipe(Effect.forkScoped, Effect.asVoid);

  return { observe, start };
});
