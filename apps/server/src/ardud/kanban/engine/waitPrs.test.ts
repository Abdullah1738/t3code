import {
  PullRequestOperationError,
  type ProjectId,
  type PullRequestDetail,
  type PullRequestRef,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import { KanbanWaitPrs, layer } from "./waitPrs.ts";
import {
  WAIT_PR_READ_MIN_MS,
  WAIT_PR_READ_TIMEOUT_MS,
  WAIT_PR_READS_PER_PASS,
  type WaitPrFacts,
  type WaitPrRequest,
} from "./waits.ts";

const pr = (number: number) => `https://github.com/Equicom-Crypto/trading-core/pull/${number}`;
const project = "project-1" as ProjectId;
const request = (number: number, patch: Partial<WaitPrRequest> = {}): WaitPrRequest => ({
  url: pr(number),
  projectId: project,
  needsHead: false,
  live: null,
  ...patch,
});
const detail = (patch: Partial<PullRequestDetail> = {}) =>
  ({
    state: "open",
    isDraft: false,
    headSha: "a1b2c3d4e5f6",
    checks: [{ status: "success" }],
    ...patch,
  }) as PullRequestDetail;

/** A host that records what it was asked and answers from `answers`. */
function host(
  answer: (
    ref: PullRequestRef,
  ) => Effect.Effect<PullRequestDetail, PullRequestService.PullRequestError> = () =>
    Effect.succeed(detail()),
) {
  const asked: Array<PullRequestRef> = [];
  const live = layer.pipe(
    Layer.provide(
      Layer.mock(PullRequestService.PullRequestService)({
        detail: (ref) => Effect.suspend(() => (asked.push(ref), answer(ref))),
      }),
    ),
  );
  return { asked, live };
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

it.effect("reads each pull request once per pass, however many requests name it", () => {
  const { asked, live } = host();
  return Effect.gen(function* () {
    const reader = yield* KanbanWaitPrs;
    const pass = yield* reader.read([
      request(512),
      request(512, { url: `${pr(512)}/files`, needsHead: true }),
      request(513),
    ]);
    assert.deepStrictEqual(
      asked.map((ref) => ref.number),
      [512, 513],
    );
    // A strict read against the wait's own host and repository, through the card's project.
    assert.deepStrictEqual(asked[0], {
      projectId: project,
      host: "github.com",
      repository: "equicom-crypto/trading-core",
      number: 512,
      allowStale: false,
    });
    assert.deepStrictEqual(pass.readings, [
      { url: pr(512), state: "open", at: iso(0), head: "a1b2c3d4e5f6", checks: "passing" },
      { url: pr(513), state: "open", at: iso(0), head: "a1b2c3d4e5f6", checks: "passing" },
    ]);
    assert.deepStrictEqual(pass.read, [pr(512), pr(513)]);
    assert.deepStrictEqual([pass.failed, pass.carried], [[], []]);
  }).pipe(Effect.provide(live));
});

it.effect(
  "asks a host about a pull request at most once per interval, serving its last reading between",
  () => {
    const { asked, live } = host();
    return Effect.gen(function* () {
      const reader = yield* KanbanWaitPrs;
      const first = yield* reader.read([request(512)]);
      // The tick comes round every 30 seconds.
      yield* TestClock.adjust(30_000);
      const second = yield* reader.read([request(512)]);
      assert.strictEqual(asked.length, 1);
      assert.deepStrictEqual(second.readings, first.readings);
      assert.deepStrictEqual(second.read, []);
      yield* TestClock.adjust(WAIT_PR_READ_MIN_MS - 30_000);
      const third = yield* reader.read([request(512)]);
      assert.strictEqual(asked.length, 2);
      assert.strictEqual(third.readings[0]?.at, iso(WAIT_PR_READ_MIN_MS));
    }).pipe(Effect.provide(live));
  },
);

it.effect("caps the reads in one pass and reads the rest first in the next", () => {
  const { asked, live } = host();
  const all = Array.from({ length: WAIT_PR_READS_PER_PASS + 3 }, (_, index) =>
    request(600 + index),
  );
  return Effect.gen(function* () {
    const reader = yield* KanbanWaitPrs;
    const first = yield* reader.read(all);
    assert.strictEqual(asked.length, WAIT_PR_READS_PER_PASS);
    assert.strictEqual(first.readings.length, WAIT_PR_READS_PER_PASS);
    assert.deepStrictEqual(
      first.carried,
      all.slice(WAIT_PR_READS_PER_PASS).map((entry) => entry.url),
    );
    yield* TestClock.adjust(30_000);
    const second = yield* reader.read(all);
    // Only the three left over are read; the first ten are inside their interval.
    assert.deepStrictEqual(
      asked.slice(WAIT_PR_READS_PER_PASS).map((ref) => ref.number),
      [610, 611, 612],
    );
    assert.strictEqual(second.readings.length, all.length);
    assert.deepStrictEqual(second.carried, []);
  }).pipe(Effect.provide(live));
});

it.effect(
  "a failed, rate-limited or slow read is unknown: no reading, and no retry inside the interval",
  () => {
    let broken = true;
    const { asked, live } = host((ref) =>
      ref.number === 513
        ? Effect.never
        : broken
          ? Effect.fail(
              new PullRequestOperationError({
                operation: "detail",
                detail: "API rate limit exceeded",
              }),
            )
          : Effect.succeed(detail({ state: "merged" })),
    );
    return Effect.gen(function* () {
      const reader = yield* KanbanWaitPrs;
      const reading = yield* Effect.forkChild(reader.read([request(512), request(513)]));
      yield* TestClock.adjust(WAIT_PR_READ_TIMEOUT_MS + 1);
      const pass = yield* Fiber.join(reading);
      assert.deepStrictEqual(pass.readings, []);
      assert.deepStrictEqual(pass.failed.toSorted(), [pr(512), pr(513)]);
      broken = false;
      yield* TestClock.adjust(30_000);
      assert.deepStrictEqual((yield* reader.read([request(512)])).readings, []);
      assert.strictEqual(asked.filter((ref) => ref.number === 512).length, 1);
      yield* TestClock.adjust(WAIT_PR_READ_MIN_MS);
      const later = yield* reader.read([request(512)]);
      assert.strictEqual(later.readings[0]?.state, "merged");
      // Merged can't change: it is never read again.
      yield* TestClock.adjust(WAIT_PR_READ_MIN_MS * 4);
      assert.strictEqual((yield* reader.read([request(512)])).readings[0]?.state, "merged");
      assert.strictEqual(asked.filter((ref) => ref.number === 512).length, 2);
    }).pipe(Effect.provide(live));
  },
);

it.effect(
  "a pull request it can't route (no project, not a PR URL) is unknown without a read",
  () => {
    const { asked, live } = host();
    return Effect.gen(function* () {
      const reader = yield* KanbanWaitPrs;
      const pass = yield* reader.read([
        request(512, { projectId: null }),
        request(1, { url: "https://example.com/notes" }),
      ]);
      assert.strictEqual(asked.length, 0);
      assert.deepStrictEqual(pass.readings, []);
      assert.strictEqual(pass.failed.length, 2);
    }).pipe(Effect.provide(live));
  },
);

it.effect(
  "prefers the work thread's own reading when it is fresh enough, and reads when it is not",
  () => {
    const { asked, live } = host(() =>
      Effect.succeed(detail({ headSha: "ffee00112233" as never })),
    );
    const liveReading = (at: number, patch: Partial<WaitPrFacts> = {}): WaitPrFacts => ({
      url: pr(512),
      state: "open",
      head: "a1b2c3d4e5f6",
      at: iso(at),
      ...patch,
    });
    return Effect.gen(function* () {
      const reader = yield* KanbanWaitPrs;
      yield* TestClock.adjust(10 * 60_000);
      const now = 10 * 60_000;
      // Fresh, and it has the head a push wait needs: no host read.
      const fresh = liveReading(now - 20_000);
      const first = yield* reader.read([request(512, { needsHead: true, live: fresh })]);
      assert.strictEqual(asked.length, 0);
      assert.deepStrictEqual(first.readings, [fresh]);
      // Fresh but no head (the thread doesn't watch the PR): a push wait needs the host's.
      const headless = liveReading(now - 20_000, { head: null });
      const second = yield* reader.read([
        request(513, { url: pr(513), needsHead: true, live: { ...headless, url: pr(513) } }),
      ]);
      assert.strictEqual(asked.length, 1);
      assert.strictEqual(second.readings[0]?.head, "ffee00112233");
      // Stale: the host is read, and its newer reading wins.
      const stale = liveReading(now - WAIT_PR_READ_MIN_MS - 1, { url: pr(514) });
      const third = yield* reader.read([request(514, { live: stale })]);
      assert.strictEqual(asked.length, 2);
      assert.deepStrictEqual(third.readings, [
        { url: pr(514), state: "open", at: iso(now), head: "ffee00112233", checks: "passing" },
      ]);
      // A thread that already saw the merge needs no second opinion, however old its reading.
      const merged = liveReading(0, { url: pr(515), state: "merged" });
      const fourth = yield* reader.read([request(515, { live: merged })]);
      assert.strictEqual(asked.length, 2);
      assert.deepStrictEqual(fourth.readings, [merged]);
    }).pipe(Effect.provide(live));
  },
);
