import { KanbanError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../../serverSettings.ts";

/** Read on each operation; a settings failure must not silently turn the gate off. */
export const selectionRoutingEnabled = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(
    Effect.mapError(
      () => new KanbanError({ code: "failed", detail: "Could not read model routing settings." }),
    ),
  );
  return current.ardudHarnessMigration?.selections === "apply";
});
