import type {
  OrchestrationV2Run,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class StartTimeoutQueueOwnerError extends Schema.TaggedError<StartTimeoutQueueOwnerError>()(
  "StartTimeoutQueueOwnerError",
  { cause: Schema.Defect() },
) {}

export class StartTimeoutQueueOwner extends Context.Reference<
  (
    threadId: ThreadId,
    commit: Effect.Effect<void, StartTimeoutQueueOwnerError>,
  ) => Effect.Effect<void, StartTimeoutQueueOwnerError>
>("t3/StartTimeoutQueueOwner", {
  defaultValue: () => (_threadId, commit) =>
    commit.pipe(Effect.mapError((cause) => new StartTimeoutQueueOwnerError({ cause }))),
}) {}
// Start admission excludes workspace preparation, lease acquisition and the
// effect queue. Ten minutes accommodates native session restoration while
// bounding a provider that never acknowledges the turn.
export const PROVIDER_START_TIMEOUT_MS = 10 * 60 * 1_000;
export const PROVIDER_START_TIMEOUT_CODE = "provider_start_timeout";
// Cancellation cannot occupy a start/control worker forever. Unconfirmed native
// cleanup remains in the durable outbox instead of escalating to a shared Stop.
export const PROVIDER_START_CLEANUP_TIMEOUT_MS = 30_000;

export const nativeOutputAcknowledgesStart = (item: OrchestrationV2TurnItem): boolean =>
  item.nativeItemRef?.nativeId != null &&
  item.nativeItemRef.strength !== "none" &&
  // These adapters can replay a prior wake into a fresh input turn. Native start/ack
  // events, rather than inherited output, confirm acceptance of that input.
  item.nativeItemRef.driver !== "pi" &&
  item.nativeItemRef.driver !== "muse";

export const providerStartAccepted = (
  run: OrchestrationV2Run,
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): boolean =>
  run.activeAttemptId !== null &&
  turns.some(
    (turn) =>
      turn.runAttemptId === run.activeAttemptId &&
      (turn.promptAcceptedAt !== undefined ||
        items.some(
          (item) => item.providerTurnId === turn.id && nativeOutputAcknowledgesStart(item),
        )),
  );

export const withoutProviderStartDeadline = (run: OrchestrationV2Run): OrchestrationV2Run => {
  const { providerStartDeadlineAt: _deadline, providerRestartCleanup: _cleanup, ...next } = run;
  return next;
};
