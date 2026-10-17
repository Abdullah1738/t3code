import { MissionId, WS_METHODS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as MissionService from "./MissionService.ts";
import * as MissionStore from "./store/MissionStore.ts";
import { makeMissionWsHandlers } from "./ws.ts";

const TestLayer = MissionService.layer.pipe(
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.layer(TestLayer)("missions WS handlers", (it) => {
  it.effect("owner actions come only from Robob client connections", () =>
    Effect.gen(function* () {
      const missions = yield* MissionService.MissionService;
      const input = { missionId: MissionId.make("m-ws"), slug: "ws", title: "WS mission" };

      const cli = makeMissionWsHandlers(missions, { surface: "cli", sessionId: "session-cli" });
      const refused = yield* Effect.flip(cli[WS_METHODS.missionsCreate](input));
      assert.equal(refused.code, "provenance-required");
      const unknown = makeMissionWsHandlers(missions, { surface: undefined, sessionId: "s" });
      assert.equal(
        (yield* Effect.flip(unknown[WS_METHODS.missionsCreate](input))).code,
        "provenance-required",
      );

      const app = makeMissionWsHandlers(missions, { surface: "desktop", sessionId: "session-app" });
      const created = yield* app[WS_METHODS.missionsCreate](input);
      const [event] = yield* missions.eventsSince(input.missionId, created.seq - 1);
      assert.deepStrictEqual(event?.provenance, {
        _tag: "owner-app",
        surface: "desktop",
        sessionId: "session-app",
      });
      assert.deepStrictEqual(event?.actor, { _tag: "owner" });
    }),
  );
});
