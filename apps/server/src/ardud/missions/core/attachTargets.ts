import { MissionError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { COMPONENT_SUBJECT_PREFIX } from "../../auth/SessionOrigins.ts";
import { optionalAuthorityStore } from "../guard/authority.ts";
import type { GuardPrincipal } from "../guard/principal.ts";

/** A thread a component may attach: it exists, and `createdBy` names the component that created it. */
export interface AttachTarget {
  readonly createdBy: string | null;
}

/**
 * What attach checks before a component brings a thread into a mission. The
 * caller's `attachedBy` proves nothing; who created the thread does.
 */
export class AttachTargets extends Context.Service<
  AttachTargets,
  {
    /** Null when the thread does not exist or was deleted. */
    readonly lookup: (threadId: ThreadId) => Effect.Effect<AttachTarget | null, MissionError>;
  }
>()("t3/ardud/missions/core/attachTargets") {}

/** Without a record of who created a thread nothing proves it, so nothing attaches. */
const NO_ATTACH_TARGETS: AttachTargets["Service"] = {
  lookup: () =>
    Effect.fail(
      new MissionError({
        code: "forbidden",
        detail: "Thread creators are not available on this server; nothing attaches.",
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

/** The component behind a credential, from the subject Robob gave it at issuance. */
const creatorComponent = (principal: GuardPrincipal | null): string | null =>
  principal?._tag === "session" && principal.subject.startsWith(COMPONENT_SUBJECT_PREFIX)
    ? principal.subject.slice(COMPONENT_SUBJECT_PREFIX.length)
    : null;

/**
 * The control API records the authenticated creator of each thread it launches
 * (guard authority kind "thread"). The thread's origin label is not used: any
 * operator session can change it. Forks and child threads have no such record,
 * so they never count as the component's own.
 */
export const AttachTargetsLive = Layer.effect(
  AttachTargets,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const authority = yield* optionalAuthorityStore;
    return AttachTargets.of({
      lookup: Effect.fn("AttachTargets.lookup")(function* (threadId: ThreadId) {
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null) return null;
        const creator = yield* authority.lookup("thread", threadId);
        return { createdBy: creatorComponent(creator) };
      }, Effect.mapError(readFailure)),
    });
  }),
);
