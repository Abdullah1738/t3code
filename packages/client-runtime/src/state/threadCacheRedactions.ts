import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type { ConnectionPersistenceError, EnvironmentCacheStore } from "../platform/persistence.ts";

interface Resume {
  snapshot: { readonly sequence: number } | undefined;
}

const stores = new WeakMap<
  EnvironmentCacheStore["Service"],
  Map<string, ReturnType<typeof make>>
>();

function make() {
  let sequence = 0;
  const resumes = new Set<WeakRef<Resume>>();
  const listeners = new Set<() => Effect.Effect<void>>();
  const lock = Semaphore.makeUnsafe(1);
  return {
    get sequence() {
      return sequence;
    },
    withPermit: lock.withPermit,
    retain(resume: Resume) {
      for (const ref of resumes) if (!ref.deref() || ref.deref() === resume) resumes.delete(ref);
      resumes.add(new WeakRef(resume));
      if ((resume.snapshot?.sequence ?? 0) < sequence) resume.snapshot = undefined;
    },
    listen: (listener: () => Effect.Effect<void>) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.add(listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
    invalidate: Effect.fn("ThreadCacheRedactions.invalidate")(function* (
      next: number,
      remove: Effect.Effect<void, ConnectionPersistenceError>,
    ) {
      if (next > sequence) {
        sequence = next;
        for (const ref of resumes) {
          const resume = ref.deref();
          if (!resume) resumes.delete(ref);
          else if ((resume.snapshot?.sequence ?? 0) < sequence) resume.snapshot = undefined;
        }
        for (const listener of listeners) yield* listener();
      }
      // A save already in flight must finish before removal. Later saves check the same fence.
      // Keep consuming the same frame until its purge succeeds, without advancing the shell cursor.
      while (true) {
        const result = yield* lock.withPermit(remove).pipe(Effect.result);
        if (Result.isSuccess(result)) return;
        yield* Effect.sleep("1 second");
      }
    }),
  };
}

/** Shared by the environment shell and collectible detail atoms, scoped to their cache store. */
export function threadCacheRedactions(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  let entries = stores.get(cache);
  if (!entries) stores.set(cache, (entries = new Map()));
  const key = JSON.stringify([environmentId, threadId]);
  let state = entries.get(key);
  if (!state) entries.set(key, (state = make()));
  return state;
}
