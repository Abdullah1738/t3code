import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../../../serverActivation.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as ViewService from "./ViewService.ts";
import * as ViewStore from "./ViewStore.ts";

/**
 * Stores each new mission's layout from the starter in force when it was
 * created. Missions created before views existed (or while this was down) get
 * the same layout lazily: reads compute it from the mission's creation time and
 * the first change stores it.
 */
export const viewsWiringLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    const views = yield* ViewService.ViewService;
    const subscription = yield* store.subscribe;
    yield* forkParked(
      Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((item) =>
          item._tag === "upsert" &&
          item.record._tag === "event" &&
          item.record.record.kind === "mission.created"
            ? views
                .seedLayout(item.record.record.missionId)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("missions views: seeding a layout failed", cause),
                  ),
                )
            : Effect.void,
        ),
      ),
    );
  }),
);

/** The views track: service, own tables and the seeding wiring. Needs MissionService + MissionStore. */
export const ViewsLive = viewsWiringLayer.pipe(
  Layer.provideMerge(ViewService.layer),
  Layer.provideMerge(ViewStore.layer),
);
