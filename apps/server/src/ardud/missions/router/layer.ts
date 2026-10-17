import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../../serverActivation.ts";
import { TERMINAL_RUN_STATUSES } from "../../control/model.ts";
import { asksRoomsLayer } from "./adapters.ts";
import { installSendGuard } from "./guardHook.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { threadsLayer } from "./ports.ts";
import * as RouterStore from "./RouterStore.ts";

/**
 * The router service with its tables and the real thread port. Referenced
 * by the asks ports and by `RouterLive`, so both share one instance.
 */
export const RouterServicesLive = MissionRouter.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(RouterStore.layer, threadsLayer)),
);

/** Asks' `AsksRooms` port backed by the router (same instance as `RouterLive`). */
export const RouterAsksRoomsLive = asksRoomsLayer.pipe(Layer.provide(RouterServicesLive));

/**
 * What a finished or paused run means for the doorbell: a run that ended
 * clears the thread's outstanding wake and may ring for what arrived since;
 * a run that is waiting on input can take a ring now.
 */
const onDomainEvent =
  (router: MissionRouter.MissionRouter["Service"]) => (event: OrchestrationV2DomainEvent) => {
    if (event.type !== "run.updated") return Effect.void;
    const status = event.payload.status;
    const work = TERMINAL_RUN_STATUSES.has(status)
      ? router.settled(event.threadId)
      : status === "waiting"
        ? router.poke(event.threadId)
        : Effect.void;
    return work.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("missions router could not update a doorbell", {
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  };

/**
 * Installs the send guard for every transport into a thread, and follows
 * run updates so doorbells ring when threads go idle (no polling).
 */
export const RouterLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* installSendGuard(router.guard);
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, onDomainEvent(router)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("missions router stopped following run updates", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
  }),
).pipe(Layer.provideMerge(RouterServicesLive));
