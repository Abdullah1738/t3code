import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../config.ts";
import { harness } from "../asks/AsksService.testkit.ts";
import { ViewsLive } from "./layer.ts";

/** The views track over a fresh database and a throwaway T3 home per test. */
export const viewsLayer = () =>
  ViewsLive.pipe(
    Layer.provideMerge(harness().layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-views-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

export const fresh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(viewsLayer()));
