import type { MissionError, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** True when mission recovery resumes this thread itself after a restart. */
type Owns = (threadId: ThreadId) => Effect.Effect<boolean, MissionError>;

// The restart continuation runs in the effect worker, which is built below
// the missions layer, so it reaches recovery through this late-bound slot
// rather than a service tag. Recovery installs it while its loops run; with
// recovery off nothing is installed and every cut run is continued as before.
let installed: Owns | null = null;

/**
 * Asked by Robob's own "Continue where you left off." before it wakes a run
 * the restart cut. Recovery wakes its member threads in order with a notice
 * that says what was lost, so a second, blind continuation would only race
 * it. A failing check never blocks the continuation.
 */
export const recoveryOwnsRestartedThread = (threadId: ThreadId): Effect.Effect<boolean> =>
  Effect.suspend(() => (installed === null ? Effect.succeed(false) : installed(threadId))).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("missions recovery could not check a restarted thread", {
        threadId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false)),
    ),
  );

/** Installs the check for the scope; a second live install is a wiring bug. */
export const installContinuationGate = (owns: Owns): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      if (installed !== null) {
        return Effect.die(
          new Error("The mission recovery continuation gate is already installed."),
        );
      }
      installed = owns;
      return Effect.void;
    }),
    () =>
      Effect.sync(() => {
        if (installed === owns) installed = null;
      }),
  );
