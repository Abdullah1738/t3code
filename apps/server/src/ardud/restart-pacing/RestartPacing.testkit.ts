import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RestartPacing from "./RestartPacing.ts";
import * as ServerSettings from "../../serverSettings.ts";

export const layer = Layer.effect(
  RestartPacing.RestartPacing,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return RestartPacing.RestartPacing.of({
      settingsSnapshot: settings.getSettings,
      register: () => Effect.void,
      acquire: () => Effect.succeed(0),
      acquireRun: () => Effect.succeed(0),
      dispatched: () => Effect.void,
      release: () => Effect.void,
      releaseRun: () => Effect.void,
    });
  }),
);
