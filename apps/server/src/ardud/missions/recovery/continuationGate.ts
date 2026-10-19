import type {
  MissionError,
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** True when this thread belongs to a live mission, so recovery resumes it. */
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
 * it. Recovery takes only what it will see itself: a run that had started
 * (an unstarted prepared continuation never shows up as cut) on a thread that
 * is not a subagent child (its parent's bookkeeping hangs off Robob's own
 * continuation). A failing check never blocks the continuation.
 */
export const recoveryTakesRestartedRun = (
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage">,
  source: Pick<OrchestrationV2Run, "startedAt">,
): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    const owns = installed;
    if (owns === null || source.startedAt === null) return Effect.succeed(false);
    if (thread.lineage.relationshipToParent === "subagent") return Effect.succeed(false);
    return owns(thread.id);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("missions recovery could not check a restarted thread", {
        threadId: thread.id,
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
