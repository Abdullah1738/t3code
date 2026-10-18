import {
  CLIENT_GUARDED_RPC_SCOPES,
  MISSIONS_RECOVERY_GUARDED_SCOPES,
  MISSIONS_RECOVERY_READ_SCOPES,
  MISSIONS_RECOVERY_WS_METHODS as M,
  MissionsRecoveryRpcs,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { missionId } from "../asks/AsksService.testkit.ts";
import { ownerAppProvenance } from "../core/provenance.ts";
import * as MissionService from "../MissionService.ts";
import { RecoveryService } from "./RecoveryService.ts";
import { harness, world } from "./testkit.ts";
import { makeRecoveryWsHandlers } from "./ws.ts";

const session = (surface: "cli" | "web") =>
  ownerAppProvenance({
    surface,
    session: { sessionId: `session-${surface}`, origin: { _tag: "owner", source: "cli" } },
  });

it.effect("owner recovery changes need a paired Robob client; the status read does not", () =>
  Effect.gen(function* () {
    yield* world();
    const recovery = yield* RecoveryService;
    const missions = yield* MissionService.MissionService;

    const cli = makeRecoveryWsHandlers(recovery, session("cli"));
    const refused = yield* Effect.flip(cli[M.settings]({ missionId, resumePerMinute: 9 }));
    assert.equal(refused.code, "provenance-required");
    const held = yield* Effect.flip(cli[M.resume]({ missionId, mode: "release" }));
    assert.equal(held.code, "provenance-required");
    const before = yield* cli[M.status]({ missionId });
    assert.equal(before.settings.resumePerMinute, 4);

    const app = makeRecoveryWsHandlers(recovery, session("web"));
    const settings = yield* app[M.settings]({ missionId, resumePerMinute: 9 });
    assert.equal(settings.resumePerMinute, 9);
    const events = yield* missions.eventsSince(missionId, 0);
    const changed = events.find((event) => event.kind === "recovery.settings-changed");
    assert.deepStrictEqual(changed?.actor, { _tag: "owner" });
    assert.deepStrictEqual(changed?.provenance, {
      _tag: "owner-app",
      surface: "web",
      sessionId: "session-web",
    });
    const after = yield* app[M.status]({ missionId });
    assert.equal(after.settings.resumePerMinute, 9);
  }).pipe(Effect.provide(harness().layer)),
);

it.effect("every recovery RPC is in the server group and declares exactly one scope", () =>
  Effect.sync(() => {
    const grouped = new Set(MissionsRecoveryRpcs.requests.keys());
    const all = new Set(WsRpcGroup.requests.keys());
    for (const method of Object.values(M)) {
      assert.isTrue(grouped.has(method), method);
      assert.isTrue(all.has(method), method);
      const read = Object.hasOwn(MISSIONS_RECOVERY_READ_SCOPES, method);
      const guarded = Object.hasOwn(MISSIONS_RECOVERY_GUARDED_SCOPES, method);
      assert.isTrue(read !== guarded, method);
      assert.equal(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method), guarded, method);
    }
  }),
);
