import * as Layer from "effect/Layer";

import * as AsksService from "./asks/AsksService.ts";
import * as MissionService from "./MissionService.ts";
import * as MissionStore from "./store/MissionStore.ts";

/**
 * Missions services. Other tracks add their layer here, one line each, and
 * read and write through `MissionStore` (see store/MissionStore.ts).
 */
export const ArdudMissionsLive = Layer.mergeAll(
  MissionService.layer,
  // tracks: add one line per track layer below
  AsksService.layerLive,
).pipe(Layer.provideMerge(MissionStore.layer));
