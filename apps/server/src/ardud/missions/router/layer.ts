import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../../serverActivation.ts";
import { TERMINAL_RUN_STATUSES } from "../../control/model.ts";
import { OwnerConditions } from "../discuss/OwnerConditions.ts";
import { asksRoomsLayer, asksSignalsLayer } from "./adapters.ts";
import * as CoordShim from "./coordShim.ts";
import { installSendGuard, requireSendGuard } from "./guardHook.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { threadsLayer } from "./ports.ts";
import { REMIND_SWEEP } from "./reminders.ts";
import * as RouterStore from "./RouterStore.ts";

// A server that loads the router runs missions, and layers below it (the
// scheduler, MCP, the control API) can try a send before `RouterLive` is up.
// Marking the guard required at load makes those sends wait for it and fail
// closed, instead of passing unchecked.
requireSendGuard();

/**
 * The router service with its tables and the real thread port. Referenced
 * by the asks ports and by `RouterLive`, so both share one instance.
 */
export const RouterServicesLive = CoordShim.layer.pipe(
  Layer.provideMerge(MissionRouter.layer),
  Layer.provideMerge(Layer.mergeAll(RouterStore.layer, threadsLayer)),
);

/**
 * Asks' `AsksRooms` and `AsksSignals` ports backed by the router (same
 * instance as `RouterLive`): posts go into rooms, and resolved asks ring the
 * doorbell of the asker and of whoever holds the released records.
 */
export const RouterAsksPortsLive = Layer.mergeAll(asksRoomsLayer, asksSignalsLayer).pipe(
  Layer.provide(RouterServicesLive),
);

/**
 * Discuss: owner conditions checked against, and settled with, the router's
 * owner requests (same router instance).
 */
export const OwnerConditionsLive = Layer.effect(
  OwnerConditions,
  Effect.map(MissionRouter.MissionRouter, (router) =>
    OwnerConditions.of({
      verify: router.verifyOwnerCondition,
      settleFor: router.settleRequestsFor,
    }),
  ),
).pipe(Layer.provide(RouterServicesLive));

/**
 * What a finished or paused run means for the doorbell: a run that ended
 * clears the thread's outstanding wake and may ring for what arrived since;
 * a run that is waiting on input can take a ring now. A question a role or
 * lane thread asks is passed to its lead.
 */
const onDomainEvent =
  (router: MissionRouter.MissionRouter["Service"]) => (event: OrchestrationV2DomainEvent) => {
    // ardud missions: routing - a role or lane thread's question goes to its lead.
    if (
      event.type === "runtime-request.updated" &&
      event.payload.kind === "user_input" &&
      event.payload.status === "pending"
    ) {
      return router.questionRaised({ threadId: event.threadId, requestId: event.payload.id }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("missions router could not tell a lead about a question", {
            threadId: event.threadId,
            requestId: event.payload.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
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
 * Installs the send guard for every transport into a thread, follows run
 * updates so doorbells ring when threads go idle, and sweeps for reminders.
 */
export const RouterLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* installSendGuard(router.guard, router.checkSend);
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, onDomainEvent(router)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("missions router stopped following run updates", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
    // Reminders look for stale deliveries on a slow timer; each pass is
    // bounded by the 30-minute rules in reminders.ts, not by the timer.
    yield* forkParked(
      router.remind.pipe(Effect.repeat(Schedule.spaced(REMIND_SWEEP)), Effect.asVoid),
    );
  }),
).pipe(Layer.provideMerge(RouterServicesLive));
