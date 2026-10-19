import { MissionError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { GuardPrincipal } from "../guard/principal.ts";
import type { ThreadActivity } from "./model.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { RouterThreads } from "./ports.ts";
import * as RouterStore from "./RouterStore.ts";

export interface Sent {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly key: string;
  readonly asOwner: boolean;
}

/**
 * A fake thread world for router tests: activity, lineage and recorded fork
 * creators come from maps, and every send is recorded. Nothing here can reach
 * a real thread.
 */
export const fakeRouterThreads = () => {
  const sent: Sent[] = [];
  const activity = new Map<ThreadId, ThreadActivity>();
  const parents = new Map<ThreadId, ThreadId>();
  /** Recorded fork creators, as the guard's authority table would hold them. */
  const creators = new Map<ThreadId, GuardPrincipal>();
  /** Threads whose facts cannot be read (the thread store fails for them). */
  const unreadable = new Set<ThreadId>();
  /** Threads that no longer exist. */
  const gone = new Set<ThreadId>();
  const archived = new Set<ThreadId>();
  /** Threads whose sends fail (the thread store refuses the message). */
  const refuseSend = new Set<ThreadId>();
  const layer = Layer.succeed(
    RouterThreads,
    RouterThreads.of({
      facts: (threadId) =>
        unreadable.has(threadId)
          ? Effect.fail(
              new MissionError({ code: "conflict", detail: `Cannot read thread ${threadId}.` }),
            )
          : Effect.sync(() =>
              gone.has(threadId)
                ? null
                : {
                    threadId,
                    title: threadId,
                    activity: activity.get(threadId) ?? "idle",
                    parentThreadId: parents.get(threadId) ?? null,
                    rootThreadId: parents.get(threadId) ?? null,
                    archived: archived.has(threadId),
                  },
            ),
      creator: (threadId) => Effect.sync(() => creators.get(threadId) ?? null),
      send: (input) =>
        refuseSend.has(input.threadId)
          ? Effect.fail(
              new MissionError({ code: "conflict", detail: `Cannot send to ${input.threadId}.` }),
            )
          : Effect.sync(() => {
              sent.push(input);
            }),
    }),
  );
  return { sent, activity, parents, creators, unreadable, gone, archived, refuseSend, layer };
};

/** The router over its tables and the fake threads; needs MissionStore and SQL. */
export const routerOverFakes = (threads: ReturnType<typeof fakeRouterThreads>) =>
  MissionRouter.layer.pipe(Layer.provideMerge(Layer.mergeAll(RouterStore.layer, threads.layer)));
