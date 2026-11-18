import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/**
 * - interactive: the web UI's snapshot builds (WebSocket).
 * - agent: build/serialize step only, for control API replies. Nothing that
 *   reads the database, waits or writes holds it.
 * - snapshot: whole-request admission for the shell snapshot and board HTTP
 *   routes and the full-shell control list, whose reads build the reply.
 * - thread: whole-request admission for one thread's HTTP views (snapshot,
 *   bounded window, history page, transcript). Opening a thread on a phone
 *   has a 6 s client deadline; on the shared snapshot lane it queued behind
 *   shell pages and board snapshots (p95 3.3 s, max 4.9 s on 10 Nov 2026).
 * - shellPage: whole-request admission for one page of the paged thread list
 *   (`GET /api/orchestration/shell?paged=true`). A phone syncing its list asks for ~37
 *   pages in a row with a 20 s deadline each; on the shared snapshot lane they queued
 *   behind board snapshots and whole-list reads that held it for 7-45 s (10 Nov 2026:
 *   pages waited up to 13 s for a permit and two gave up after 20-25 s unadmitted).
 *   A page is at most 500 rows (0.7 MB on the synthetic fixture, about 1.3 MB in the
 *   live traces; rows are not capped in bytes), so three at once stay cheap.
 * - poll: control thread detail reads, isolated from lists, snapshots and MCP.
 * - controlRead: control messages, live lists and run evidence on foreground readers. One request
 *   at a time leaves the other foreground reader available to the UI, even
 *   when an all=true read hydrates a large imported transcript.
 * - mcp: a whole large MCP read (t3_thread_read, board/card reads...).
 *   It bounds how many large results are built at once; a slow one delays
 *   only other large MCP reads.
 * - wiki: selected wiki pages/indexes, isolated from slow thread-list reads.
 *
 * Light control reads (identity, thread status, health) take no lane at all.
 * On 10 Nov 2026 one shared 2-permit lane was held ~1.8 permits by
 * GET /threads (p95 14.6 s) and MCP reads (t3_thread_read up to 153 s, while
 * waiting for reader slots), and everything else on it hit client timeouts.
 */
export type Lane =
  | "interactive"
  | "agent"
  | "snapshot"
  | "thread"
  | "shellPage"
  | "poll"
  | "controlRead"
  | "mcp"
  | "wiki";

export const AdmissionObserver = Context.Reference<
  ((sample: { lane: Lane; waitMs: number; runMs: number; acquired: boolean }) => void) | undefined
>("t3/ardud/http/ReplyBuilders/AdmissionObserver", { defaultValue: () => undefined });

export class ReplyBuilders extends Context.Service<
  ReplyBuilders,
  { readonly [K in Lane]: Semaphore.Semaphore }
>()("t3/ardud/http/ReplyBuilders") {}

// Lanes are shared across connections, not allocated per board or request.
// The control read permit includes hydration and SQL, so even all=true reads
// cannot take both foreground readers. Response encoding uses the agent lane.
export const PERMITS: { readonly [K in Lane]: number } = {
  interactive: 2,
  agent: 2,
  snapshot: 2,
  thread: 2,
  shellPage: 3,
  poll: 4,
  controlRead: 1,
  mcp: 4,
  wiki: 4,
};

export const layer = Layer.effect(
  ReplyBuilders,
  Effect.gen(function* () {
    return {
      interactive: yield* Semaphore.make(PERMITS.interactive),
      agent: yield* Semaphore.make(PERMITS.agent),
      snapshot: yield* Semaphore.make(PERMITS.snapshot),
      thread: yield* Semaphore.make(PERMITS.thread),
      shellPage: yield* Semaphore.make(PERMITS.shellPage),
      poll: yield* Semaphore.make(PERMITS.poll),
      controlRead: yield* Semaphore.make(PERMITS.controlRead),
      mcp: yield* Semaphore.make(PERMITS.mcp),
      wiki: yield* Semaphore.make(PERMITS.wiki),
    };
  }),
);

export const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>, lane: Lane = "agent") =>
  Effect.flatMap(Effect.serviceOption(ReplyBuilders), (builders) =>
    builders._tag === "Some"
      ? Effect.suspend(() => {
          return Effect.gen(function* () {
            const clock = yield* Clock.Clock;
            const observer = yield* AdmissionObserver;
            const started = clock.monotonicTimeNanosUnsafe();
            let admitted: bigint | undefined;
            return yield* builders.value[lane]
              .withPermits(1)(
                Effect.suspend(() => {
                  admitted = clock.monotonicTimeNanosUnsafe();
                  return Effect.annotateCurrentSpan({
                    "reply_builder.admission_wait_ms": Number(admitted - started) / 1e6,
                    "reply_builder.lane": lane,
                  }).pipe(Effect.andThen(effect));
                }),
              )
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    const ended = clock.monotonicTimeNanosUnsafe();
                    try {
                      observer?.({
                        lane,
                        waitMs: Number((admitted ?? ended) - started) / 1e6,
                        runMs: admitted === undefined ? 0 : Number(ended - admitted) / 1e6,
                        acquired: admitted !== undefined,
                      });
                    } catch {
                      // Instrumentation must not change the reply or leak its permit.
                    }
                  }),
                ),
              );
          });
        })
      : effect,
  );

export const interactive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  bounded(effect, "interactive");
