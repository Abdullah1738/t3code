import * as Layer from "effect/Layer";

import * as AsksService from "./asks/AsksService.ts";
import { missionsDeskRouteLayer } from "./asks/http.ts";
import { missionsRouteLayer } from "./http.ts";
import * as MissionService from "./MissionService.ts";
import { policyRouteLayer } from "./policy/http.ts";
import { PolicyLive } from "./policy/layer.ts";
import { scribeRouteLayer } from "./scribe/http.ts";
import { ScribeLive } from "./scribe/layer.ts";
import * as MissionStore from "./store/MissionStore.ts";

/**
 * Missions services. Other tracks add their layer here, one line each, and
 * read and write through `MissionStore` (see store/MissionStore.ts).
 */
export const ArdudMissionsLive = Layer.mergeAll(
  MissionService.layer,
  // tracks: add one line per track layer below
  ScribeLive,
  AsksService.layerLive,
  PolicyLive,
).pipe(Layer.provideMerge(MissionStore.layer));

/**
 * HTTP routes under /api/ardud/missions. Other tracks add their route layer
 * here, one line each; server.ts mounts this once.
 */
export const ArdudMissionsRoutesLive = Layer.mergeAll(
  missionsRouteLayer,
  // tracks: add one line per track route layer below
  scribeRouteLayer,
  missionsDeskRouteLayer,
  policyRouteLayer,
);
