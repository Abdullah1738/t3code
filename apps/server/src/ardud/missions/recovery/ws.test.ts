import {
  CLIENT_GUARDED_RPC_SCOPES,
  MISSIONS_RECOVERY_GUARDED_SCOPES,
  MISSIONS_RECOVERY_READ_SCOPES,
  MISSIONS_RECOVERY_WS_METHODS as M,
  MissionId,
  MissionsRecoveryRpcs,
  ThreadId,
  WsRpcGroup,
  type RecoveryIncident,
  type RecoveryThread,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { missionId } from "../asks/AsksService.testkit.ts";
import { ownerAppProvenance } from "../core/provenance.ts";
import * as MissionService from "../MissionService.ts";
import { RecoveryService } from "./RecoveryService.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import { harness, plus, world } from "./testkit.ts";
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

    // A web connection made with a component's or an unpaired credential is not the owner.
    for (const origin of [
      { _tag: "component", component: "stream-recovery" } as const,
      undefined,
    ]) {
      const other = ownerAppProvenance({
        surface: "web",
        session: { sessionId: "session-other", ...(origin ? { origin } : {}) },
      });
      const handlers = makeRecoveryWsHandlers(recovery, other);
      const denied = yield* Effect.flip(handlers[M.settings]({ missionId, resumePerMinute: 9 }));
      assert.equal(denied.code, "provenance-required");
    }

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

const recoveryThread = (missionOf: MissionId, threadId: string, position: number) =>
  ({
    missionId: missionOf,
    threadId: ThreadId.make(threadId),
    title: threadId,
    roleId: null,
    roleKind: null,
    laneId: null,
    laneName: null,
    subMissionId: null,
    position,
    cutRunId: null,
    lastActivity: null,
    lastActivityAt: null,
    serverContinued: false,
    interruptReason: null,
    handoffFrom: null,
    lostChildren: [],
    holds: [],
    action: "resume",
    reason: "cut by the restart",
    state: "sent",
    stateReason: null,
    instruction: null,
    noticeAt: null,
    decidedBy: null,
  }) satisfies RecoveryThread;

const incidentAt = (
  id: string,
  seconds: number,
  threads: ReadonlyArray<RecoveryThread>,
): RecoveryIncident => ({
  id,
  cause: "server-restart",
  source: "missions-recovery",
  detectedAt: plus(seconds),
  windowStart: plus(seconds - 60),
  windowEnd: plus(seconds),
  downSeconds: 60,
  missionIds: [...new Set(threads.map((thread) => thread.missionId))],
  threads,
  clearedAt: seconds < 0 ? plus(seconds + 30) : null,
});

it.effect("the incident list reads every incident that touched the mission, newest first", () =>
  Effect.gen(function* () {
    yield* world();
    const recovery = yield* RecoveryService;
    const store = yield* RecoveryStore.RecoveryStore;
    const other = MissionId.make("m-other");
    // An old incident that touched the mission, then more than a page of
    // newer ones elsewhere, then a recent shared one.
    yield* store.saveIncident(
      incidentAt("rcv-old", -7200, [recoveryThread(missionId, "t-master", 0)]),
      plus(-7200),
    );
    for (let index = 0; index < 60; index += 1) {
      yield* store.saveIncident(
        incidentAt(`rcv-elsewhere-${index}`, -3600 + index, [recoveryThread(other, "t-x", 0)]),
        plus(-3600 + index),
      );
    }
    yield* store.saveIncident(
      incidentAt("rcv-shared", 10, [
        recoveryThread(other, "t-x", 0),
        recoveryThread(missionId, "t-lane", 2),
        recoveryThread(missionId, "t-master", 0),
      ]),
      plus(10),
    );

    const handlers = makeRecoveryWsHandlers(recovery, null);
    const incidents = yield* handlers[M.incidents]({ missionId });
    assert.deepStrictEqual(
      incidents.map((incident) => incident.id),
      ["rcv-shared", "rcv-old"],
    );
    const [shared] = incidents;
    assert.deepStrictEqual(shared?.missionIds, [missionId]);
    assert.deepStrictEqual(
      shared?.threads.map((thread) => thread.threadId),
      ["t-master", "t-lane"],
    );
    assert.isNotNull(incidents[1]?.clearedAt);

    const missing = yield* Effect.flip(handlers[M.incidents]({ missionId: other }));
    assert.equal(missing.code, "not-found");
  }).pipe(Effect.provide(harness().layer)),
);
