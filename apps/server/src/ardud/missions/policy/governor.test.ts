import {
  type Lane,
  LaneId,
  type Mission,
  MissionId,
  type MissionTier,
  type Pool,
  PoolHoldId,
  PoolId,
  RoleId,
  type Role,
  SubMissionId,
  type SubMission,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  type GovernorInput,
  GOVERNOR_PARK_PREFIX,
  admissionOrder,
  decide,
  parkOrder,
  poolPressure,
} from "./governor.ts";
import { newPool } from "./pools.ts";
import { newRole } from "./roles.ts";

const NOW = "2026-10-17T10:00:00.000Z";
const hours = (h: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(NOW), { hours: h }));

const mission = (
  id: string,
  tier: MissionTier,
  extra: Partial<
    Pick<Mission, "weight" | "guaranteedShare" | "borrowCeiling" | "focusSubMissionId">
  > = {},
): Mission => ({
  id: MissionId.make(id),
  slug: id,
  title: id,
  goal: "",
  status: "active",
  tier,
  weight: extra.weight ?? 1,
  guaranteedShare: extra.guaranteedShare ?? 0.2,
  borrowCeiling: extra.borrowCeiling ?? 1,
  projectId: null,
  masterRoleId: RoleId.make(`${id}:master`),
  focusSubMissionId: extra.focusSubMissionId ?? null,
  health: "green",
  lockedFields: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const sub = (missionId: string, id: string, order: number): SubMission => ({
  id: SubMissionId.make(id),
  missionId: MissionId.make(missionId),
  title: id,
  intent: "",
  order,
  fillIdleCapacity: false,
  status: "active",
  coordinatorRoleId: null,
  intendedEffort: null,
  actualEffort: null,
  health: "green",
  lockedFields: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const lane = (
  missionId: string,
  id: string,
  extra: Partial<
    Pick<Lane, "status" | "subMissionId" | "leadRoleId" | "statusReason" | "context">
  > = {},
): Lane => ({
  id: LaneId.make(id),
  missionId: MissionId.make(missionId),
  subMissionId: extra.subMissionId ?? null,
  name: id,
  purpose: "",
  status: extra.status ?? "idle",
  statusReason: extra.statusReason ?? null,
  leadRoleId: extra.leadRoleId ?? RoleId.make(`${missionId}:lane-lead:${id}`),
  threadId: null,
  currentItemId: null,
  lastEvidence: null,
  context: extra.context ?? null,
  lastActiveAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const claudePool = (used: number, usage: Partial<Pool["usage"]> = {}): Pool => ({
  ...newPool(
    {
      id: "claude",
      name: "Claude pool",
      unit: "% of 5h window",
      capacity: 100,
      scope: { _tag: "global" },
      kind: "observed",
      backend: "9router",
    },
    NOW,
  ),
  usage: {
    used,
    window: "5h",
    resetsAt: usage.resetsAt ?? hours(3),
    runOutAt: usage.runOutAt ?? null,
    sampledAt: NOW,
  },
});

const roles: ReadonlyArray<Role> = [
  newRole({ missionId: MissionId.make("crpko"), kind: "master" }, NOW),
  newRole({ missionId: MissionId.make("crpko"), kind: "scribe" }, NOW),
];

const base = (overrides: Partial<GovernorInput> = {}): GovernorInput => ({
  missions: [mission("crpko", "P1", { guaranteedShare: 0.3 }), mission("side", "P2")],
  subMissions: [sub("crpko", "release", 0), sub("crpko", "harness", 1)],
  lanes: [
    lane("crpko", "master-lane", { status: "working", leadRoleId: RoleId.make("crpko:master") }),
    lane("crpko", "scribe-lane", { status: "working", leadRoleId: RoleId.make("crpko:scribe") }),
    lane("crpko", "release", { subMissionId: SubMissionId.make("release"), status: "working" }),
    lane("crpko", "harness", { subMissionId: SubMissionId.make("harness"), status: "idle" }),
    lane("side", "side-a", { status: "idle" }),
  ],
  roles,
  pools: [claudePool(50)],
  usage: [
    { missionId: MissionId.make("crpko"), poolId: PoolId.make("claude"), used: 40 },
    { missionId: MissionId.make("side"), poolId: PoolId.make("claude"), used: 30 },
  ],
  now: NOW,
  ...overrides,
});

describe("governor", () => {
  it("reads pressure from the projection and the reserve", () => {
    expect(poolPressure(claudePool(50), NOW).level).toBe("ok");
    expect(poolPressure(claudePool(86), NOW).level).toBe("tight");
    expect(poolPressure(claudePool(100), NOW).level).toBe("exhausted");
    expect(
      poolPressure(claudePool(40, { runOutAt: hours(1), resetsAt: hours(3) }), NOW).level,
    ).toBe("tight");
    expect(
      poolPressure(claudePool(40, { runOutAt: hours(4), resetsAt: hours(3) }), NOW).level,
    ).toBe("ok");
  });

  it("does nothing while pools are healthy", () => {
    const decision = decide(base());
    expect(decision.actions).toEqual([]);
    expect(decision.suggestions).toEqual([]);
  });

  it("parks P2 borrowers first, then P1 lanes above guarantee by sub-mission order", () => {
    const input = base({ pools: [claudePool(90)] });
    const order = parkOrder(input).map((candidate) => candidate.lane.id);
    // side (P2, 30% > 20% guarantee) first; then crpko (P1, 40% > 30%) lowest sub-mission first.
    expect(order).toEqual(["side-a", "harness", "release"]);
    expect(order).not.toContain("master-lane");
    expect(order).not.toContain("scribe-lane");

    const decision = decide(input);
    expect(decision.actions).toEqual([
      {
        _tag: "park",
        laneId: "side-a",
        missionId: "side",
        reason: `${GOVERNOR_PARK_PREFIX} Claude pool is at 90%, inside the 15% reserve`,
      },
    ]);
  });

  it("parks a working lane only at its next safe point", () => {
    const input = base({
      pools: [claudePool(90)],
      lanes: [lane("crpko", "release", { status: "working" })],
    });
    expect(decide(input).actions[0]?._tag).toBe("park-at-safe-point");
  });

  it("never parks below a guarantee or P0, and asks the owner instead", () => {
    const input = base({
      pools: [claudePool(95)],
      missions: [mission("crpko", "P1", { guaranteedShare: 0.5 }), mission("urgent", "P0")],
      lanes: [
        lane("crpko", "release", { status: "idle" }),
        lane("urgent", "hotfix", { status: "working" }),
      ],
      usage: [
        { missionId: MissionId.make("crpko"), poolId: PoolId.make("claude"), used: 40 },
        { missionId: MissionId.make("urgent"), poolId: PoolId.make("claude"), used: 55 },
      ],
    });
    expect(parkOrder(input)).toEqual([]);
    const decision = decide(input);
    expect(decision.actions).toEqual([]);
    expect(decision.suggestions).toHaveLength(1);
    expect(decision.suggestions[0]).toMatchObject({
      author: "governor",
      acceptor: "owner",
      targetKind: "lane",
      target: { kind: "lane", id: "release" },
      status: "open",
    });
  });

  it("resumes its own parked lanes when pools recover, highest tier first", () => {
    const parkedReason = `${GOVERNOR_PARK_PREFIX} Claude pool tight`;
    const input = base({
      lanes: [
        lane("side", "side-a", { status: "parked", statusReason: parkedReason }),
        lane("crpko", "harness", { status: "parked", statusReason: parkedReason }),
        lane("crpko", "owner-parked", { status: "parked", statusReason: "owner parked it" }),
      ],
    });
    expect(decide(input).actions).toEqual([
      {
        _tag: "resume",
        laneId: "harness",
        missionId: "crpko",
        reason: "governor: every watched pool is back under its reserve",
      },
    ]);
  });

  it("orders admission by tier, then weighted dominant share, within ceilings", () => {
    const input = base({
      missions: [
        mission("crpko", "P1", { guaranteedShare: 0.3, weight: 2 }),
        mission("juno", "P1", { guaranteedShare: 0.3 }),
        mission("side", "P2", { borrowCeiling: 0.25 }),
      ],
      lanes: [lane("crpko", "a"), lane("juno", "b"), lane("side", "c")],
      usage: [
        { missionId: MissionId.make("crpko"), poolId: PoolId.make("claude"), used: 40 },
        { missionId: MissionId.make("juno"), poolId: PoolId.make("claude"), used: 30 },
        { missionId: MissionId.make("side"), poolId: PoolId.make("claude"), used: 30 },
      ],
    });
    const order = admissionOrder(input);
    // crpko: 0.4 / 2 = 0.2 beats juno 0.3 / 1. side is past its 25% ceiling.
    expect(order.map((entry) => [entry.missionId, entry.canAdmit])).toEqual([
      ["crpko", true],
      ["juno", true],
      ["side", false],
    ]);
  });

  it("admits only the focus sub-mission when focus mode is on", () => {
    const input = base({
      missions: [mission("crpko", "P1", { focusSubMissionId: SubMissionId.make("release") })],
      lanes: [lane("crpko", "harness", { subMissionId: SubMissionId.make("harness") })],
    });
    expect(admissionOrder(input)[0]).toMatchObject({ canAdmit: false });
  });

  it("suggests more capacity when a queue has waited too long, never changes it", () => {
    const env = newPool(
      {
        id: "crpko-dev-env",
        name: "Crpko dev env",
        unit: "slot",
        capacity: 1,
        scope: { _tag: "mission", missionId: MissionId.make("crpko") },
        kind: "lease",
        backend: "native",
      },
      NOW,
    );
    const queued = {
      id: PoolHoldId.make("crpko-dev-env#2"),
      poolId: env.id,
      missionId: MissionId.make("crpko"),
      holder: { _tag: "system", component: "test" } as const,
      amount: 1,
      purpose: "harness run",
      fence: 2,
      status: "queued" as const,
      leaseExpiresAt: null,
      takenAt: null,
      releasedAt: null,
      releaseNote: null,
      createdAt: hours(-1),
    };
    const decision = decide(base({ pools: [claudePool(50), env], queued: [queued] }));
    expect(decision.actions).toEqual([]);
    expect(decision.suggestions[0]).toMatchObject({
      targetKind: "pool",
      acceptor: "master",
      after: { capacity: 2 },
    });
  });
});
