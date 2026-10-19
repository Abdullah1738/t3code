/**
 * Pull request watches. A watch wakes its thread with text that quotes the
 * pull request's comments, so starting one on another thread is a send into
 * that thread, and every wake speaks as whoever started the watch.
 */
import type { ThreadId } from "@t3tools/contracts";
import { threadPullRequestKeyOf } from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";

import { guardSender, type SendGuardFailed, type SendRefused } from "../router/guardPaths.ts";
import type { SendSender } from "../router/model.ts";
import { prWatchKey, type AuthorityStore } from "./authority.ts";
import { principalKey, type GuardPrincipal } from "./principal.ts";

export interface WatchedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url?: string | undefined;
}

const canonical = (link: WatchedLink) => ({
  host: link.host,
  repository: link.repository,
  number: link.number,
  ...(link.url === undefined ? {} : { url: link.url }),
});

/** The authority key of a watch on `threadId`'s link. */
export const watchKey = (threadId: ThreadId, link: WatchedLink) =>
  prWatchKey({ threadId, ...canonical(link) });

/**
 * Starts a watch as `principal`. Watching your own thread, and anything the
 * owner does, passes; a watch on another thread must be able to reach it. The
 * principal that passes is recorded as the watch's initiator.
 */
export const authorizeWatch = (
  store: AuthorityStore,
  input: {
    readonly principal: GuardPrincipal;
    readonly threadId: ThreadId;
    readonly link: WatchedLink;
  },
): Effect.Effect<void, SendRefused | SendGuardFailed> =>
  Effect.gen(function* () {
    const { principal, threadId, link } = input;
    const own =
      principal._tag === "owner" ||
      (principal._tag === "thread" && principal.threadId === threadId);
    if (!own) {
      yield* guardSender({
        path: "pr-watch",
        targetThreadId: threadId,
        from: principal,
        text: `Watch pull request ${threadPullRequestKeyOf(canonical(link))} and wake this thread with its checks, reviews and comments.`,
        requestKey: `pr-watch:${watchKey(threadId, link)}:${principalKey(principal)}`,
      });
    }
    yield* store.record("pr-watch", watchKey(threadId, link), principal);
  });

/**
 * Whether a watch wake may go straight into its thread. It speaks as the
 * recorded initiator; a watch with nothing recorded (started before the guard
 * existed) is an unknown sender. A refused wake is already in the mission's
 * room or the owner's inbox, so the caller drops it from the thread.
 */
export const admitWatchWake = (
  store: AuthorityStore,
  input: {
    readonly threadId: ThreadId;
    readonly link: WatchedLink;
    readonly text: string;
    readonly wakeId: string;
  },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const key = watchKey(input.threadId, input.link);
    const initiator = yield* store.read("pr-watch", key);
    if (initiator?._tag === "owner") return true;
    const from: SendSender = initiator ?? {
      _tag: "mcp-client",
      sessionId: `pr-watch:${key}`,
      label: "pull request watch with no recorded initiator",
    };
    return yield* guardSender({
      path: "pr-watch-wake",
      targetThreadId: input.threadId,
      from,
      text: input.text,
      requestKey: `pr-watch-wake:${input.wakeId}`,
    }).pipe(
      Effect.as(true),
      Effect.catchTags({
        SendRefused: () => Effect.succeed(false),
        SendGuardFailed: (error) =>
          Effect.logWarning("missions guard: pull request wake not delivered", {
            threadId: input.threadId,
            error: error.message,
          }).pipe(Effect.as(false)),
      }),
    );
  });
