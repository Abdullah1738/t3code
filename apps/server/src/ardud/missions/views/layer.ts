import { MissionError, type MissionProvenance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../../../serverActivation.ts";
import * as Ports from "../asks/ports.ts";
import type { SuggestionApplication } from "../asks/suggestionModel.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as ViewService from "./ViewService.ts";
import * as ViewStore from "./ViewStore.ts";

/**
 * A `layout` suggestion offers a mission the starter layout: `after` is the
 * starter version the master offered. Accepting resets the mission's layout
 * to the starter (its own sections stay), unless the starter moved on since.
 */
export const applyLayoutSuggestion =
  (
    views: ViewService.ViewService["Service"],
    starters: ViewStore.ViewStore["Service"]["starters"],
  ) =>
  (application: SuggestionApplication, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      const missionId = application.suggestion.missionId;
      if (missionId === null) {
        return yield* new MissionError({
          code: "invalid",
          detail: "A layout suggestion needs a mission.",
        });
      }
      const starter = ViewStore.currentStarter(yield* starters);
      if (application.after !== starter.version) {
        return yield* new MissionError({
          code: "conflict",
          detail: `The starter layout is at v${starter.version} now, not the v${String(application.after)} offered.`,
        });
      }
      yield* views.editLayout(provenance, {
        missionId,
        ops: [{ _tag: "reset" }],
        changeNote: `Took the starter layout v${starter.version}.`,
      });
      return `Applied: layout reset to the starter layout v${starter.version}; the mission's own sections stayed.`;
    });

/**
 * Stores each new mission's layout from the starter in force when it was
 * created (missions created before views existed get the same layout lazily:
 * reads compute it and the first change stores it), expires an archived
 * mission's images, and applies accepted starter offers.
 */
export const viewsWiringLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    const views = yield* ViewService.ViewService;
    const viewStore = yield* ViewStore.ViewStore;
    const registry = yield* Ports.SuggestionApplierRegistry;
    yield* registry.register(["layout"], applyLayoutSuggestion(views, viewStore.starters));
    const subscription = yield* store.subscribe;
    const quietly = (what: string) =>
      Effect.catchCause((cause) => Effect.logWarning(`missions views: ${what} failed`, cause));
    yield* forkParked(
      Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((item) => {
          if (item._tag !== "upsert" || item.record._tag !== "event") return Effect.void;
          const event = item.record.record;
          switch (event.kind) {
            case "mission.created":
              return views.seedLayout(event.missionId).pipe(quietly("seeding a layout"));
            case "mission.archived":
              return views.expireAssets(event.missionId).pipe(quietly("expiring images"));
            default:
              return Effect.void;
          }
        }),
      ),
    );
  }),
);

/**
 * The views track: service, own tables and the wiring. Needs MissionService,
 * MissionStore, the suggestion applier registry and ServerConfig.
 */
export const ViewsLive = viewsWiringLayer.pipe(
  Layer.provideMerge(ViewService.layer),
  Layer.provideMerge(ViewStore.layer),
);
