import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RestartPacing from "./RestartPacing.ts";

export const layer = Layer.succeed(RestartPacing.RestartPacing, {
  register: () => Effect.void,
  acquire: () => Effect.succeed(0),
  acquireRun: () => Effect.succeed(0),
  dispatched: () => Effect.void,
});
