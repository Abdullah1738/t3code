/**
 * The wait PR reader: reads from their hosts the pull requests that waits
 * point at and no work thread watches (an outside author's PR, a parent PR).
 *
 * It is a plain read. It takes requests and returns readings, writes nothing
 * to the board and holds no board lock, so the caller runs it before taking
 * one. It keeps the last reading of each PR in memory and asks a host about a
 * PR at most once per `WAIT_PR_READ_MIN_MS`, however many cards wait on it and
 * however often it is called. A read that fails leaves the PR unknown until a
 * later one succeeds, and unknown never ends a wait.
 */
import type { PullRequestRef } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as Waits from "./waits.ts";

export interface WaitPrPass {
  /**
   * The readings this pass has: one per PR it knows something about, with the
   * work thread's own reading merged in when it is the fresher one.
   */
  readonly readings: ReadonlyArray<Waits.WaitPrFacts>;
  /** PRs a host was asked about in this pass. */
  readonly read: ReadonlyArray<string>;
  /** PRs whose read failed, timed out or could not be routed: unknown this pass. */
  readonly failed: ReadonlyArray<string>;
  /** PRs that were due but over the pass's cap: they go first next time. */
  readonly carried: ReadonlyArray<string>;
}

export class KanbanWaitPrs extends Context.Service<
  KanbanWaitPrs,
  {
    /** Readings for the pull requests asked about. Never fails. */
    readonly read: (requests: ReadonlyArray<Waits.WaitPrRequest>) => Effect.Effect<WaitPrPass>;
  }
>()("t3/ardud/kanban/engine/waitPrs/KanbanWaitPrs") {}

interface Held {
  /** When a host was last asked, whether or not it answered. */
  readonly attemptedAt: number;
  /** The last reading a host gave. */
  readonly reading: Waits.WaitPrFacts | null;
  /** When a pass last asked about this PR; entries nobody asks about are dropped. */
  readonly wantedAt: number;
}

/** A PR nobody has asked about for this long is forgotten. */
const FORGET_AFTER_MS = 60 * 60 * 1000;
/** Host reads in flight at once. */
const READ_CONCURRENCY = 4;

const timeOf = (iso: string | null | undefined): number | null => {
  const ms = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The work thread already knows enough: its reading is recent, and carries a
 * head when a push wait needs one. A merged PR needs no second opinion.
 */
const liveCovers = (request: Waits.WaitPrRequest, nowMs: number): boolean => {
  const live = request.live;
  if (live === null) return false;
  if (live.state === "merged") return true;
  const at = timeOf(live.at);
  if (at === null || nowMs - at >= Waits.WAIT_PR_READ_MIN_MS) return false;
  return !request.needsHead || (live.head ?? null) !== null;
};

export const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const held = new Map<string, Held>();

  const readOne = Effect.fn("KanbanWaitPrs.readOne")(
    function* (request: Waits.WaitPrRequest, nowMs: number) {
      const link = parseChangeRequestUrl(request.url);
      if (link === null || request.projectId === null) return null;
      const ref: PullRequestRef = {
        projectId: request.projectId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        // A held copy could be minutes old; a wait needs what the host says now.
        allowStale: false,
      };
      const detail = yield* pullRequests
        .detail(ref)
        .pipe(Effect.timeoutOption(Waits.WAIT_PR_READ_TIMEOUT_MS), Effect.map(Option.getOrNull));
      return detail === null ? null : Waits.readingFromDetail(request.url, detail, nowMs);
    },
    // Rate limits, a host that is down, a PR this account can't see: all unknown.
    (effect, request) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("wait PR read failed", {
            url: request.url,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      ),
  );

  const read = Effect.fn("KanbanWaitPrs.read")(function* (
    requests: ReadonlyArray<Waits.WaitPrRequest>,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    // One request per PR, whatever the caller sent.
    const wanted = new Map<string, Waits.WaitPrRequest>();
    for (const request of requests) {
      const key = Waits.prKey(request.url);
      const first = wanted.get(key);
      wanted.set(
        key,
        first === undefined
          ? request
          : {
              url: first.url,
              projectId: first.projectId ?? request.projectId,
              needsHead: first.needsHead || request.needsHead,
              live: first.live ?? request.live,
            },
      );
    }
    for (const [key, entry] of held) {
      if (!wanted.has(key) && nowMs - entry.wantedAt >= FORGET_AFTER_MS) held.delete(key);
    }
    const due: Array<readonly [string, Waits.WaitPrRequest]> = [];
    for (const [key, request] of wanted) {
      const entry = held.get(key);
      if (entry !== undefined) held.set(key, { ...entry, wantedAt: nowMs });
      if (liveCovers(request, nowMs)) continue;
      if (entry?.reading?.state === "merged") continue;
      if (entry !== undefined && nowMs - entry.attemptedAt < Waits.WAIT_PR_READ_MIN_MS) continue;
      due.push([key, request]);
    }
    // Longest since it was asked about first; one never asked about before all.
    due.sort(
      ([a], [b]) =>
        (held.get(a)?.attemptedAt ?? -Infinity) - (held.get(b)?.attemptedAt ?? -Infinity),
    );
    const now = due.slice(0, Waits.WAIT_PR_READS_PER_PASS);
    const carried = due.slice(Waits.WAIT_PR_READS_PER_PASS).map(([, request]) => request.url);
    const failed: Array<string> = [];
    yield* Effect.forEach(
      now,
      ([key, request]) =>
        readOne(request, nowMs).pipe(
          Effect.map((reading) => {
            if (reading === null) failed.push(request.url);
            held.set(key, {
              attemptedAt: nowMs,
              // A failed read leaves the PR unknown until one succeeds.
              reading,
              wantedAt: nowMs,
            });
          }),
        ),
      { concurrency: READ_CONCURRENCY, discard: true },
    );
    const readings = [...wanted].flatMap(([key, request]) => {
      const cached = held.get(key)?.reading ?? null;
      return Waits.mergePrReadings(
        request.live === null ? [] : [request.live],
        cached === null ? [] : [cached],
      );
    });
    return {
      readings,
      read: now.map(([, request]) => request.url),
      failed,
      carried,
    } satisfies WaitPrPass;
  });

  return KanbanWaitPrs.of({ read });
});

export const layer = Layer.effect(KanbanWaitPrs, make);
