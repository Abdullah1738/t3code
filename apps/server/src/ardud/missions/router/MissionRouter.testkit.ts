import { MissionError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
 * A fake thread world for router tests: activity and lineage come from maps,
 * and every send is recorded. Nothing here can reach a real thread.
 */
export const fakeRouterThreads = () => {
  const sent: Sent[] = [];
  const activity = new Map<ThreadId, ThreadActivity>();
  const parents = new Map<ThreadId, ThreadId>();
  /** Threads whose facts cannot be read (the thread store fails for them). */
  const unreadable = new Set<ThreadId>();
  const layer = Layer.succeed(
    RouterThreads,
    RouterThreads.of({
      facts: (threadId) =>
        unreadable.has(threadId)
          ? Effect.fail(
              new MissionError({ code: "conflict", detail: `Cannot read thread ${threadId}.` }),
            )
          : Effect.sync(() => ({
              threadId,
              title: threadId,
              activity: activity.get(threadId) ?? "idle",
              parentThreadId: parents.get(threadId) ?? null,
              rootThreadId: parents.get(threadId) ?? null,
            })),
      send: (input) =>
        Effect.sync(() => {
          sent.push(input);
        }),
    }),
  );
  return { sent, activity, parents, unreadable, layer };
};

/** The router over its tables and the fake threads; needs MissionStore and SQL. */
export const routerOverFakes = (threads: ReturnType<typeof fakeRouterThreads>) =>
  MissionRouter.layer.pipe(Layer.provideMerge(Layer.mergeAll(RouterStore.layer, threads.layer)));
