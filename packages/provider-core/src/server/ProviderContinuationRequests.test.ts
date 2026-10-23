import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderContinuationRequests from "./ProviderContinuationRequests.ts";

const request = (threadId: string) => ({
  threadId: ThreadId.make(threadId),
  providerThreadId: ProviderThreadId.make(`provider-thread:${threadId}`),
  driver: ProviderDriverKind.make("opencode"),
  detail: null,
});

describe("ProviderContinuationRequests", () => {
  it.effect("counts a request as pending from offer until the worker settles it", () =>
    Effect.gen(function* () {
      const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const pending = (threadId: string) => requests.pending!(ThreadId.make(threadId));

      yield* requests.offer(request("thread-a"));
      yield* requests.offer(request("thread-a"));
      assert.isTrue(yield* pending("thread-a"));
      assert.isFalse(yield* pending("thread-b"));

      // Taking it is not enough: the dispatch it leads to has not happened yet.
      const first = yield* requests.take;
      assert.isTrue(yield* pending("thread-a"));
      yield* requests.settle!(first);
      assert.isTrue(yield* pending("thread-a"));

      yield* requests.settle!(yield* requests.take);
      assert.isFalse(yield* pending("thread-a"));
    }).pipe(Effect.provide(ProviderContinuationRequests.layer)),
  );
});
