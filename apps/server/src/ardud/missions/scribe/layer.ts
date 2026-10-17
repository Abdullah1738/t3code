import * as Layer from "effect/Layer";

import * as ScribeService from "./ScribeService.ts";
import * as ScribeStore from "./ScribeStore.ts";

/** Scribe service plus its own tables; needs core's `MissionStore` and the server sqlite. */
export const ScribeLive = ScribeService.layer.pipe(Layer.provideMerge(ScribeStore.layer));
