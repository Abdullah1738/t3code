import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { readThreadShellsShared } from "./sharedThreadShellReads.ts";

const makeReads = () => {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    calls,
    readMany: (ids: ReadonlyArray<string>) =>
      Effect.sync(() => {
        calls.push(ids);
        return new Map(ids.map((id) => [id, `${id}:shell:${calls.length}`] as const));
      }),
    readOne: (id: string) =>
      Effect.sync(() => {
        calls.push([id]);
        return `${id}:shell:${calls.length}`;
      }),
  };
};

it.effect("subscribers that see the same events share one read", () =>
  Effect.gen(function* () {
    const owner = {};
    const reads = makeReads();
    const wanted = [
      { threadId: "a", sequence: 10 },
      { threadId: "b", sequence: 11 },
    ];
    const read = () =>
      readThreadShellsShared({ owner, wanted, ...reads, batch: true, batchMinThreads: 2 });

    const first = yield* read();
    const second = yield* read();
    expect(reads.calls).toEqual([["a", "b"]]);
    expect(second).toEqual(first);
    expect(first.get("a")).toBe("a:shell:1");

    // A new sequence for one thread reads only that thread, one row.
    const third = yield* readThreadShellsShared({
      owner,
      wanted: [
        { threadId: "a", sequence: 12 },
        { threadId: "b", sequence: 11 },
      ],
      ...reads,
      batch: true,
      batchMinThreads: 2,
    });
    expect(reads.calls).toEqual([["a", "b"], ["a"]]);
    expect(third.get("a")).toBe("a:shell:2");
    expect(third.get("b")).toBe("b:shell:1");
  }),
);

it.effect("a concurrent subscriber joins the read in flight", () =>
  Effect.gen(function* () {
    const owner = {};
    const gate = yield* Deferred.make<void>();
    let reads = 0;
    const read = () =>
      readThreadShellsShared({
        owner,
        wanted: [{ threadId: "a", sequence: 1 }],
        readMany: () => Effect.die("unused"),
        readOne: (id: string) =>
          Effect.gen(function* () {
            reads += 1;
            yield* Deferred.await(gate);
            return `${id}:shell`;
          }),
        batch: true,
        batchMinThreads: 2,
      });
    const first = yield* Effect.forkChild(read());
    const second = yield* Effect.forkChild(read());
    yield* Effect.yieldNow;
    // The first subscriber leaves; the read it started still completes for the second.
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(gate, undefined);
    expect((yield* Fiber.join(second)).get("a")).toBe("a:shell");
    expect(reads).toBe(1);
  }),
);

it.effect("a failed read is not cached", () =>
  Effect.gen(function* () {
    const owner = {};
    let attempts = 0;
    const read = () =>
      readThreadShellsShared({
        owner,
        wanted: [{ threadId: "a", sequence: 1 }],
        readMany: () => Effect.die("unused"),
        readOne: (id: string) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1 ? Effect.fail("boom" as const) : Effect.succeed(`${id}:shell`);
          }),
        batch: false,
        batchMinThreads: 2,
      });
    expect(yield* Effect.flip(read())).toBe("boom");
    expect((yield* read()).get("a")).toBe("a:shell");
    expect(attempts).toBe(2);
  }),
);

it.effect("drops the oldest entries past the cap", () =>
  Effect.gen(function* () {
    const owner = {};
    const reads = makeReads();
    const read = (sequence: number) =>
      readThreadShellsShared({
        owner,
        wanted: [{ threadId: "a", sequence }],
        ...reads,
        batch: true,
        batchMinThreads: 2,
        maxEntries: 2,
      });
    yield* read(1);
    yield* read(2);
    yield* read(3);
    yield* read(1);
    expect(reads.calls.length).toBe(4);
  }),
);
