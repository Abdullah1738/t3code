import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AsksService from "../asks/AsksService.ts";
import * as MissionService from "../MissionService.ts";
import * as PolicyService from "./PolicyService.ts";
import * as PolicyStore from "./PolicyStore.ts";
import { portsLayer, suggestionsLayer } from "./ports.ts";

/**
 * The policy track: service, own tables, ports and background loops. Needs
 * MissionStore plus the server's thread, schedule and process services.
 * MissionService and AsksService are the same layers `ArdudMissionsLive`
 * builds, so they are shared, not built twice.
 */
export const PolicyLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const policy = yield* PolicyService.PolicyService;
    yield* policy.start;
  }),
).pipe(
  Layer.provideMerge(PolicyService.layer),
  Layer.provideMerge(PolicyStore.layer),
  Layer.provideMerge(Layer.mergeAll(portsLayer, suggestionsLayer)),
  Layer.provide(AsksService.layerLive),
  Layer.provide(MissionService.layer),
);
