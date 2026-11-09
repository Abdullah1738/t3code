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
        const route = boardEventRoute(event);
        if (route === "turnEnd") return service.notifyTurnEnded(event.threadId);
        if (route === "threadChanged")
          return service
            .notifyThreadChanged(event.threadId)
            .pipe(Effect.catchCause(warnUnlessInterrupted("missions board thread change")));
        return Effect.void;
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
  Layer.provideMerge(KanbanServiceLayer.pipe(Layer.provide(ownerRouteModeLayer))),
  Layer.provide(KanbanModelsLayer),
  Layer.provide(KanbanThreadsLayer),
  Layer.provideMerge(KanbanStoreLayer),
);
