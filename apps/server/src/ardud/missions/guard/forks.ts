/**
 * Forks. A fork copies its source's context and inherits its lineage, and the
 * router counts a thread descended from the master as master-created. So
 * forking someone else's thread is a send into it, and the fork's creator is
 * recorded apart from its lineage (see `forkCreator`).
 */
import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlError from "effect/sql/SqlError";

import { guardSender, type SendGuardFailed, type SendRefused } from "../router/guardPaths.ts";
import type { AuthorityStore } from "./authority.ts";
import { principalKey, type GuardPrincipal } from "./principal.ts";

/**
 * Checks and records a fork. The owner and a thread forking itself pass; any
 * other caller must be able to reach the source thread.
 */
export const guardFork = (
  store: AuthorityStore,
  input: {
    readonly caller: GuardPrincipal;
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly title: string | undefined;
  },
): Effect.Effect<void, SendRefused | SendGuardFailed> =>
  Effect.gen(function* () {
    const { caller, sourceThreadId } = input;
    const own =
      caller._tag === "owner" || (caller._tag === "thread" && caller.threadId === sourceThreadId);
    if (!own) {
      yield* guardSender({
        path: "fork",
        targetThreadId: sourceThreadId,
        from: caller,
        text: `Fork this thread${input.title === undefined ? "" : ` as "${input.title}"`}.`,
        requestKey: `fork:${principalKey(caller)}:${sourceThreadId}:${input.title ?? ""}`,
      });
    }
    yield* store.record("fork", input.targetThreadId, caller);
  });

/**
 * Who created a fork, or `null` when nothing was recorded (a fork made before
 * the guard, or by an in-process caller). Membership should count a fork as
 * created by the master only when this is the owner or the master.
 */
export const forkCreator = (
  store: AuthorityStore,
  threadId: ThreadId,
): Effect.Effect<GuardPrincipal | null> => store.read("fork", threadId);

/**
 * Subagent mirrors and delegated children are created by the thread that
 * spawned them, so that thread is recorded as their creator. The event sink
 * calls this inside the transaction that commits their `thread.created`: a
 * child never exists without its creator, and a failed record fails the write.
 */
export const recordChildCreators = (
  store: AuthorityStore,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.forEach(
    events,
    (event) => {
      if (event.type !== "thread.created") return Effect.void;
      const { id, lineage } = event.payload;
      return lineage.relationshipToParent === "subagent" && lineage.parentThreadId !== null
        ? store.bind("fork", id, { _tag: "thread", threadId: lineage.parentThreadId, title: "" })
        : Effect.void;
    },
    { discard: true },
  );
