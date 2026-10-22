import * as Layer from "effect/Layer";

import * as AsksService from "./asks/AsksService.ts";
import { missionsDeskRouteLayer } from "./asks/http.ts";
import { asksWiringLayer } from "./asks/wiring.ts";
import { AttachTargetsLive } from "./core/attachTargets.ts";
import * as MasterControls from "./core/MasterControls.ts";
import { MissionOwnerNameLive } from "./core/ownerName.ts";
import * as RuleService from "./core/RuleService.ts";
import { editorWiringLayer } from "./editorWiring.ts";
import { enrolAdoptionLayer } from "./guard/enrolAdoption.ts";
import { missionsRouteLayer } from "./http.ts";
import * as MissionService from "./MissionService.ts";
import { policyRouteLayer } from "./policy/http.ts";
import { PolicyLive } from "./policy/layer.ts";
import { recoveryRouteLayer } from "./recovery/http.ts";
import { RecoveryLive } from "./recovery/layer.ts";
import { coordShimRouteLayer } from "./router/coordHttp.ts";
import { OwnerConditionsLive, RouterAsksPortsLive, RouterLive } from "./router/layer.ts";
import { leadRoutedRouteLayer } from "./router/leadRoutedHttp.ts";
import { masterFeedLayer } from "./router/masterFeed.ts";
import { reportsDeskRouteLayer } from "./router/reportsHttp.ts";
import { requestsDeskRouteLayer } from "./router/requestsHttp.ts";
import { scribeRouteLayer } from "./scribe/http.ts";
import { ScribeLive } from "./scribe/layer.ts";
import * as MissionStore from "./store/MissionStore.ts";
import { ViewsLive } from "./views/layer.ts";

/**
 * Missions services. Other tracks add their layer here, one line each, and
 * read and write through `MissionStore` (see store/MissionStore.ts).
 */
const MissionTracksLive = Layer.mergeAll(
  MissionService.layer.pipe(Layer.provide(MissionOwnerNameLive)), // ardud missions: fix-p3
  // tracks: add one line per track layer below
  ScribeLive,
  AsksService.layerLive.pipe(Layer.provide(RouterAsksPortsLive)),
  // policy builds the same AsksService layer, so it needs the same router ports
  PolicyLive.pipe(Layer.provide(RouterAsksPortsLive)),
  RouterLive,
).pipe(
  Layer.provideMerge(OwnerConditionsLive), // ardud missions: router (discuss)
  Layer.provide(AttachTargetsLive), // ardud missions: r22 fixes (attach checks who created the thread)
);

/**
 * Services built on the tracks: rules, the scribe registered as editor, and
 * asks' wiring (suggestion appliers, editor suggestions through asks).
 */
export const ArdudMissionsLive = Layer.mergeAll(
  RuleService.layer,
  // master-anywhere lookups and secret-card closes (SecretRequests comes from server.ts)
  MasterControls.layer,
  editorWiringLayer,
  asksWiringLayer.pipe(Layer.provide(RuleService.layer)),
  // the master's inbox feed: editor digests, master-routed approvals and drafts
  masterFeedLayer,
  // ardud missions: recovery (needs MissionService from the tracks below)
  RecoveryLive,
  // ardud missions: views (templates, sections, layouts; needs MissionService)
  ViewsLive,
  // the master adopts a newly enrolled thread's legacy schedules and watches
  enrolAdoptionLayer,
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
  recoveryRouteLayer,
  requestsDeskRouteLayer, // ardud missions: router (owner requests)
  leadRoutedRouteLayer, // ardud missions: r22 fixes (telegram leaves lead-routed requests alone)
  reportsDeskRouteLayer, // ardud missions: r22 reports (an iMessage chat's bugs and ideas to the master)
);
