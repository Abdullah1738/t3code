import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type { ThreadNotIdleReason } from "./idle.ts";

export type ArchiveIfIdleResult =
  | { readonly archived: true }
  | { readonly archived: false; readonly reason: ThreadNotIdleReason; readonly detail: string };

/**
 * Archives the thread only if it is still idle when the orchestrator takes its
 * lock. A refusal leaves the thread untouched and says why.
 */
export const archiveIfIdle = Effect.fn("ArchiveIfIdle.archiveIfIdle")(function* (input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly expectedNativeSessionId?: string | undefined;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  return yield* threads
    .dispatch({
      type: "thread.archive",
      commandId: input.commandId,
      threadId: input.threadId,
      ifIdle:
        input.expectedNativeSessionId === undefined
          ? {}
          : { expectedNativeSessionId: input.expectedNativeSessionId },
    })
    .pipe(
      Effect.as<ArchiveIfIdleResult>({ archived: true }),
      Effect.catchTags({
        OrchestratorThreadNotIdleError: (error) =>
          Effect.succeed<ArchiveIfIdleResult>({
            archived: false,
            reason: error.reason,
            detail: error.detail,
          }),
      }),
    );
});
