import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";

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

it.live("a subscriber interrupted while it registers a batch still starts the read", () =>
  Effect.gen(function* () {
    // 11 Nov 2026 review: with a small scheduler budget the claim loop yielded
    // between publishing entries and starting the reader. Interrupting there left
    // the entries without a reader, and the next subscriber for "t0" hung.
    const owner = {};
    const reads = makeReads();
    const wanted = Array.from({ length: 64 }, (_, index) => ({
      threadId: `t${index}`,
      sequence: 1,
    }));
    const first = yield* readThreadShellsShared({
      owner,
      wanted,
      ...reads,
      batch: true,
      batchMinThreads: 2,
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8), Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(first);
    const second = yield* readThreadShellsShared({
      owner,
      wanted: [{ threadId: "t0", sequence: 1 }],
      ...reads,
      batch: true,
      batchMinThreads: 2,
      // Long enough that only a real read, not the fallback, can answer in time.
      waitTimeout: "1 minute",
    }).pipe(Effect.timeout("2 seconds"));
    expect(second.get("t0")).toMatch(/^t0:shell:/);
    expect(reads.calls.length).toBe(1);
    expect(reads.calls[0]).toHaveLength(64);
  }),
);

it.live("a waiter whose shared read never settles reads the shell itself", () =>
  Effect.gen(function* () {
    const owner = {};
    let reads = 0;
    const read = () =>
      readThreadShellsShared({
        owner,
        wanted: [{ threadId: "a", sequence: 1 }],
        readMany: () => Effect.die("unused"),
        readOne: (id: string) =>
          Effect.suspend(() => {
            reads += 1;
            return reads === 1 ? Effect.never : Effect.succeed(`${id}:shell:${reads}`);
          }),
        batch: false,
        batchMinThreads: 2,
        waitTimeout: "30 millis",
      });
    const first = yield* Effect.forkChild(read());
    const second = yield* read().pipe(Effect.timeout("2 seconds"));
    expect(second.get("a")).toBe("a:shell:2");
    expect((yield* Fiber.join(first).pipe(Effect.timeout("2 seconds"))).get("a")).toMatch(
      /^a:shell:/,
    );
    // The stuck entry was dropped: a later subscriber reads again.
    expect((yield* read().pipe(Effect.timeout("2 seconds"))).get("a")).toMatch(/^a:shell:/);
  }),
);
