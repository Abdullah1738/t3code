import { MissionError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ControlStore from "../../control/ControlStore.ts";

/** A thread a component may attach: it exists, and `origin` names who created it. */
export interface AttachTarget {
  readonly origin: string | null;
}

/**
 * What attach checks before a component brings a thread into a mission. The
 * caller's `attachedBy` proves nothing; the thread's recorded origin does.
 */
export class AttachTargets extends Context.Service<
  AttachTargets,
  {
    /** Null when the thread does not exist or was deleted. */
    readonly lookup: (threadId: ThreadId) => Effect.Effect<AttachTarget | null, MissionError>;
  }
>()("t3/ardud/missions/core/attachTargets") {}

/** Without thread origins nothing proves who created a thread, so nothing attaches. */
const NO_ATTACH_TARGETS: AttachTargets["Service"] = {
  lookup: () =>
    Effect.fail(
      new MissionError({
        code: "forbidden",
        detail: "Thread origins are not available on this server; nothing attaches.",
      }),
    ),
};

export const attachTargets = Effect.map(Effect.serviceOption(AttachTargets), (found) =>
  Option.getOrElse(found, () => NO_ATTACH_TARGETS),
);

const readFailure = (error: unknown) =>
  new MissionError({
    code: "conflict",
    detail: `Cannot read the thread: ${error instanceof Error ? error.message : String(error)}`,
  });

/** The control API records a thread's origin when a component creates it; children inherit the root's. */
export const AttachTargetsLive = Layer.effect(
  AttachTargets,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const origins = yield* ControlStore.ControlStore;
    return AttachTargets.of({
      lookup: Effect.fn("AttachTargets.lookup")(function* (threadId: ThreadId) {
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null) return null;
        const own = yield* origins.getOrigin(threadId);
        const root = shell.lineage.rootThreadId;
        const origin = own ?? (root === threadId ? null : yield* origins.getOrigin(root));
        return { origin };
      }, Effect.mapError(readFailure)),
    });
  }),
).pipe(Layer.provide(ControlStore.layer));
