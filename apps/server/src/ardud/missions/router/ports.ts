import { CommandId, MessageId, MissionError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { stateFromShell } from "../../control/model.ts";
import { optionalAuthorityStore } from "../guard/authority.ts";
import { forkCreator } from "../guard/forks.ts";
import type { GuardPrincipal } from "../guard/principal.ts";
import type { ThreadActivity } from "./model.ts";

/** What the router needs to know about a thread. */
export interface ThreadFacts {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly activity: ThreadActivity;
  readonly parentThreadId: ThreadId | null;
  readonly rootThreadId: ThreadId | null;
  /** Archived threads take no deliveries. */
  readonly archived: boolean;
}

/**
 * The router's only way to touch real threads: read their state and put a
 * line in their queue. Tests use a fake so nothing they run reaches a thread.
 * Sends made here are internal (doorbell wakes, owner-forwarded knocks) and
 * never pass through the send guard.
 */
export class RouterThreads extends Context.Service<
  RouterThreads,
  {
    readonly facts: (threadId: ThreadId) => Effect.Effect<ThreadFacts | null, MissionError>;
    /**
     * Who made the thread, as the guard recorded it when the thread was
     * forked. `null` when a successful read found nothing (legacy forks):
     * lineage alone never makes such a thread a mission member. A record
     * that cannot be read fails, and membership fails with it.
     */
    readonly creator: (threadId: ThreadId) => Effect.Effect<GuardPrincipal | null, MissionError>;
    /** Queues `text` in the thread. `key` makes retries land once. */
    readonly send: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
      readonly key: string;
      readonly asOwner: boolean;
    }) => Effect.Effect<void, MissionError>;
  }
>()("t3/ardud/missions/router/ports/RouterThreads") {}

const threadFailure = (what: string) => (error: unknown) =>
  new MissionError({
    code: "conflict",
    detail: `${what}: ${error instanceof Error ? error.message : String(error)}`,
  });

export const threadsLayer = Layer.effect(
  RouterThreads,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const authority = yield* optionalAuthorityStore;
    const shellOf = (threadId: ThreadId) =>
      threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadFailure("Cannot read the thread")));
    return RouterThreads.of({
      facts: (threadId) =>
        shellOf(threadId).pipe(
          Effect.map((shell) =>
            shell === null
              ? null
              : {
                  threadId,
                  title: shell.title,
                  activity:
                    shell.deletedAt !== null && shell.deletedAt !== undefined
                      ? "missing"
                      : stateFromShell(shell),
                  parentThreadId: shell.lineage.parentThreadId,
                  rootThreadId: shell.lineage.rootThreadId,
                  archived: shell.archivedAt !== null && shell.archivedAt !== undefined,
                },
          ),
        ),
      creator: (threadId) => forkCreator(authority, threadId),
      send: ({ threadId, text, key, asOwner }) =>
        Effect.gen(function* () {
          const shell = yield* shellOf(threadId);
          if (shell === null) {
            return yield* new MissionError({ code: "not-found", detail: `No thread ${threadId}.` });
          }
          const id = `ardud-missions:${key}`;
          yield* threads
            .sendToThread({
              projectId: shell.projectId,
              commandId: CommandId.make(id),
              messageId: MessageId.make(id),
              threadId,
              text,
              attachments: [],
              mode: "queue",
              createdBy: asOwner ? "user" : "system",
              creationSource: "server",
            })
            .pipe(Effect.mapError(threadFailure("Cannot send to the thread")));
        }),
    });
  }),
);
