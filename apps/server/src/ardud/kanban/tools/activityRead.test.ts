import { assert, it } from "@effect/vitest";
import { KanbanBoardId, KanbanError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ActivityRead from "./activityRead.ts";

const boardId = KanbanBoardId.make("board-coalesce");
const window = { since: "2026-11-17T00:00:00.000Z", until: "2026-11-18T00:00:00.000Z" };
const empty = {
  cards: [],
  events: [],
  threads: [],
  pools: [],
  board: null,
  dispatchCards: [],
  dispatchPools: [],
  holds: new Map(),
  reviews: new Map(),
  workThreadHomes: new Map(),
  assignmentWakeRetries: new Map(),
  slotHistory: { events: [], recordedSince: null },
  prior: [],
  readinessBefore: [],
  after: [],
};

it.effect("coalesces identical pending reads and keeps the remaining caller alive", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const service = {
      activity: () =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return empty;
        }),
    };
    const first = yield* ActivityRead.read(service, boardId, window).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(entered);
    const second = yield* ActivityRead.read(service, boardId, window).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    assert.equal(calls, 1);
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(second);
    assert.equal(result.activity.boardId, boardId);
    assert.deepEqual(result.activity.window, window);
    yield* ActivityRead.read(service, boardId, window);
    assert.equal(calls, 2);
  }),
);

it.effect("does not coalesce different boards, exact second boundaries, or service instances", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const instance = () => ({
      activity: () =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.await(release);
          return empty;
        }),
    });
    const service = instance();
    const other = instance();
    const fibers = [];
    for (const [instance, board, range] of [
      [service, boardId, window],
      [service, KanbanBoardId.make("other-board"), window],
      [service, boardId, { ...window, until: "2026-11-18T00:00:01.000Z" }],
      [service, boardId, { ...window, since: "2026-11-17T00:00:01.000Z" }],
      [other, boardId, window],
    ] as const)
      fibers.push(
        yield* ActivityRead.read(instance, board, range).pipe(
          Effect.forkChild({ startImmediately: true }),
        ),
      );
    assert.equal(calls, 5);
    yield* Deferred.succeed(release, undefined);
    for (const fiber of fibers) yield* Fiber.join(fiber);
  }),
);

it.effect("failed and abandoned reads do not leave a cached result", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let calls = 0;
    const service = {
      activity: () =>
        Effect.gen(function* () {
          calls++;
          if (calls === 1)
            return yield* Effect.fail(new KanbanError({ code: "failed", detail: "probe" }));
          if (calls === 2) {
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }
          return empty;
        }),
    };
    const failed = yield* Effect.exit(ActivityRead.read(service, boardId, window));
    assert.equal(failed._tag, "Failure");
    const abandoned = yield* ActivityRead.read(service, boardId, window).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(abandoned);
    yield* ActivityRead.read(service, boardId, window);
    assert.equal(calls, 3);
  }),
);

it.effect("an abandoned run's delayed cleanup cannot remove its replacement", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const cleanupEntered = yield* Deferred.make<void>();
    const cleanupRelease = yield* Deferred.make<void>();
    const replacementEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const service = {
      activity: () =>
        Effect.gen(function* () {
          calls++;
          if (calls === 1) {
            yield* Deferred.succeed(firstEntered, undefined);
            return yield* Effect.never.pipe(
              Effect.ensuring(
                Deferred.succeed(cleanupEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanupRelease)),
                ),
              ),
            );
          }
          yield* Deferred.succeed(replacementEntered, undefined);
          yield* Deferred.await(release);
          return empty;
        }),
    };
    const first = yield* ActivityRead.read(service, boardId, window).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(firstEntered);
    const interrupted = yield* Fiber.interrupt(first).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(cleanupEntered);
    const replacement = yield* ActivityRead.read(service, boardId, window).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(replacementEntered);
    yield* Deferred.succeed(cleanupRelease, undefined);
    yield* Fiber.join(interrupted);
    const follower = yield* ActivityRead.read(service, boardId, window).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    assert.equal(calls, 2);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(replacement);
    yield* Fiber.join(follower);
    assert.equal(calls, 2);
  }),
);
