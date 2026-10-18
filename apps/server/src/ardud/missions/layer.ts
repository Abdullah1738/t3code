import * as Layer from "effect/Layer";

import * as AsksService from "./asks/AsksService.ts";
import { missionsDeskRouteLayer } from "./asks/http.ts";
import { asksWiringLayer } from "./asks/wiring.ts";
import * as RuleService from "./core/RuleService.ts";
import { editorWiringLayer } from "./editorWiring.ts";
import { missionsRouteLayer } from "./http.ts";
import * as MissionService from "./MissionService.ts";
import { policyRouteLayer } from "./policy/http.ts";
import { PolicyLive } from "./policy/layer.ts";
import { coordShimRouteLayer } from "./router/coordHttp.ts";
import { RouterAsksRoomsLive, RouterLive } from "./router/layer.ts";
import { scribeRouteLayer } from "./scribe/http.ts";
import { ScribeLive } from "./scribe/layer.ts";
import * as MissionStore from "./store/MissionStore.ts";

/**
 * Missions services. Other tracks add their layer here, one line each, and
 * read and write through `MissionStore` (see store/MissionStore.ts).
 */
const MissionTracksLive = Layer.mergeAll(
  MissionService.layer,
  // tracks: add one line per track layer below
  ScribeLive,
  AsksService.layerLive.pipe(Layer.provide(RouterAsksRoomsLive)),
  // policy builds the same AsksService layer, so it needs the same router port
  PolicyLive.pipe(Layer.provide(RouterAsksRoomsLive)),
  RouterLive,
);

/**
 * Services built on the tracks: rules, the scribe registered as editor, and
 * asks' wiring (suggestion appliers, editor suggestions through asks).
 */
export const ArdudMissionsLive = Layer.mergeAll(
  RuleService.layer,
  editorWiringLayer,
  asksWiringLayer.pipe(Layer.provide(RuleService.layer)),
).pipe(Layer.provideMerge(MissionTracksLive), Layer.provideMerge(MissionStore.layer));

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
  coordShimRouteLayer,
);
