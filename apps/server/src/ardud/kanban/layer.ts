import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";
import { TERMINAL_RUN_STATUSES } from "../control/model.ts";
import {
  KanbanService,
  OwnerRouteMode,
  ReplayReads,
  DeferWriteEffects,
  layer as KanbanServiceLayer,
} from "./engine/KanbanService.ts";
import { layer as KanbanModelsLayer } from "./engine/models.ts";
import { KanbanScripts, layer as KanbanScriptsLayer } from "./engine/ScriptService.ts";
import { layer as KanbanThreadsLayer } from "./engine/threads.ts";
import { layer as KanbanStoreLayer } from "./store/KanbanStore.ts";

/**
 * Events that change a thread's live state. A native question opens and resolves
 * as a runtime request, and a native answer resolves it with no run update, so
 * the request event must reach the board. Node and turn-item updates fire for every
 * streamed paragraph; forwarding them would reread the whole board on each one.
 */
const THREAD_STATE_EVENTS = new Set<string>(["run.updated", "runtime-request.updated"]);

/** Which board action a domain event triggers, if any. Exported so the route is tested itself. */
export const boardEventRoute = (
  event: OrchestrationV2DomainEvent,
): "turnEnd" | "threadChanged" | null => {
  if (event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status))
    return "turnEnd";
  return THREAD_STATE_EVENTS.has(event.type) ? "threadChanged" : null;
};

/**
 * Streamed output (nodes, turn items) fires per paragraph and does not change
 * what the board reads about a thread; everything else naming a thread does.
 */
const STREAMING_EVENTS = new Set<string>(["node.updated", "turn-item.updated"]);

/** The thread an event changed, for the board's read fences. Exported so it is tested itself. */
export const threadEventOf = (event: OrchestrationV2DomainEvent): string | null => {
  if (STREAMING_EVENTS.has(event.type)) return null;
  const threadId = (event as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : null;
};

/**
 * Owner answers and posts reply once they and their routing are committed;
 * delivery follows in the background. `ROBOB_KANBAN_INLINE_OWNER_ROUTES=1`
 * restores delivery inside the reply.
 */
const ownerRouteModeLayer = Layer.effect(
  OwnerRouteMode,
  Effect.gen(function* () {
    const inline = yield* Config.Boolean("ROBOB_KANBAN_INLINE_OWNER_ROUTES").pipe(
      Config.withDefault(false),
    );
    return inline ? "inline" : "deferred";
  }).pipe(Effect.orElseSucceed((): OwnerRouteMode => "deferred")),
);

/**
 * A stale rerun of a board operation reuses the thread reads its earlier
 * attempt made (see `outsideRead`). `ROBOB_KANBAN_REPLAY_READS=0` reads again.
 */
const replayReadsLayer = Layer.effect(
  ReplayReads,
  Config.Boolean("ROBOB_KANBAN_REPLAY_READS").pipe(
    Config.withDefault(true),
    Effect.orElseSucceed(() => true),
  ),
);

/**
 * Card and discussion writes reply on commit; their thread follow-ons run from
 * route rows. `ROBOB_KANBAN_DEFER_WRITE_EFFECTS=0` runs them inside the reply.
 */
const deferWriteEffectsLayer = Layer.effect(
  DeferWriteEffects,
  Config.Boolean("ROBOB_KANBAN_DEFER_WRITE_EFFECTS").pipe(
    Config.withDefault(true),
    Effect.orElseSucceed(() => true),
  ),
);

/** Typing heartbeat, review completion and the dispatcher's safety net. */
const TICK = "30 seconds";

const warnUnlessInterrupted = (what: string) => (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.void
    : Effect.logWarning(what, { cause: Cause.pretty(cause) });

/**
 * The Missions board: its service, the worker that runs dispatch and turn
 * ends one at a time, the run-update follower, board scripts and the
 * periodic tick.
 */
export const ArdudKanbanLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* KanbanService;
    const scripts = yield* KanbanScripts;
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* forkParked(service.worker);
    yield* forkParked(
      scripts.recover.pipe(
        Effect.catchCause(warnUnlessInterrupted("board scripts could not close old runs")),
        Effect.andThen(scripts.listen),
        Effect.catchCause(warnUnlessInterrupted("board scripts stopped following the board")),
      ),
    );
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        const changed = threadEventOf(event);
        const touched = changed === null ? Effect.void : service.threadEvent(changed);
        const route = boardEventRoute(event);
        if (route === "turnEnd")
          return touched.pipe(Effect.andThen(service.notifyTurnEnded(event.threadId)));
        if (route === "threadChanged")
          return touched.pipe(
            Effect.andThen(service.notifyThreadChanged(event.threadId)),
            Effect.catchCause(warnUnlessInterrupted("missions board thread change")),
          );
        return touched;
      }).pipe(
        Effect.catchCause(warnUnlessInterrupted("missions board stopped following run updates")),
      ),
    );
    yield* forkParked(
      service.tick.pipe(
        Effect.catchCause(warnUnlessInterrupted("missions board tick failed")),
        Effect.andThen(
          scripts.tick.pipe(Effect.catchCause(warnUnlessInterrupted("board scripts tick failed"))),
        ),
        Effect.repeat(Schedule.spaced(TICK)),
        Effect.asVoid,
      ),
    );
    // Its own fiber: a probe can take a minute and must not delay the tick.
    yield* forkParked(
      service.probeOutages.pipe(
        Effect.catchCause(warnUnlessInterrupted("provider probe failed")),
        Effect.repeat(Schedule.spaced("1 minute")),
        Effect.asVoid,
      ),
    );
  }),
).pipe(
  Layer.provideMerge(KanbanScriptsLayer),
  Layer.provideMerge(
    KanbanServiceLayer.pipe(
      Layer.provide(ownerRouteModeLayer),
      Layer.provide(replayReadsLayer),
      Layer.provide(deferWriteEffectsLayer),
    ),
  ),
  Layer.provide(KanbanModelsLayer),
  Layer.provide(KanbanThreadsLayer),
  Layer.provideMerge(KanbanStoreLayer),
);
