import {
  MISSIONS_POLICY_GUARDED_SCOPES,
  MISSIONS_POLICY_READ_SCOPES,
  MISSIONS_POLICY_WS_METHODS as M,
  MissionsPolicyRpcs,
  RoleId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as MissionService from "../MissionService.ts";
import { ownerAppProvenance } from "../core/provenance.ts";
import { SOL_XHIGH, HAIKU } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import { CRPKO, OWNER, makePorts, testLayer } from "./testing.ts";
import { makePolicyWsHandlers } from "./ws.ts";

const ports = makePorts();

it.layer(testLayer(ports.layer))("mission policy WS handlers", (it) => {
  it.effect("owner writes need a Robob client connection; reads do not", () =>
    Effect.gen(function* () {
      const missions = yield* MissionService.MissionService;
      yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
      const policy = yield* PolicyService.PolicyService;
      const reviewer = RoleId.make(`${CRPKO}:reviewer`);
      const change = { roleId: reviewer, modelSelection: HAIKU, reason: "try haiku" };

      const cli = makePolicyWsHandlers(
        policy,
        ownerAppProvenance({
          surface: "cli",
          session: { sessionId: "session-cli", subject: "one-time-token" },
        }),
      );
      const refused = yield* Effect.flip(cli[M.setRoleModel](change));
      assert.equal(refused.code, "provenance-required");
      const roles = yield* cli[M.roles]({ missionId: CRPKO });
      assert.deepStrictEqual(
        roles.roles.find((role) => role.id === reviewer)?.modelSelection,
        SOL_XHIGH,
      );

      const app = makePolicyWsHandlers(
        policy,
        ownerAppProvenance({
          surface: "web",
          session: { sessionId: "session-web", subject: "one-time-token" },
        }),
      );
      const changed = yield* app[M.setRoleModel](change);
      const [event] = yield* missions.eventsSince(CRPKO, changed.seq - 1);
      assert.equal(event?.kind, "role.model-changed");
      assert.deepStrictEqual(event?.actor, { _tag: "owner" });
      assert.deepStrictEqual(event?.provenance, {
        _tag: "owner-app",
        surface: "web",
        sessionId: "session-web",
      });
      const after = yield* app[M.roles]({ missionId: CRPKO });
      assert.deepStrictEqual(
        after.roles.find((role) => role.id === reviewer)?.modelSelection,
        HAIKU,
      );
    }),
  );

  it.effect("every policy RPC is in the server group and declares exactly one scope", () =>
    Effect.sync(() => {
      const methods = Object.values(M);
      const grouped = new Set(MissionsPolicyRpcs.requests.keys());
      const all = new Set(WsRpcGroup.requests.keys());
      for (const method of methods) {
        assert.isTrue(grouped.has(method), method);
        assert.isTrue(all.has(method), method);
        const scopes = [
          Object.hasOwn(MISSIONS_POLICY_READ_SCOPES, method),
          Object.hasOwn(MISSIONS_POLICY_GUARDED_SCOPES, method),
        ].filter(Boolean);
        assert.equal(scopes.length, 1, method);
      }
    }),
  );
});
