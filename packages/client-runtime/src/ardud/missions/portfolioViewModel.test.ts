import type { MissionId, MissionListSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import { newMissionInput, orderBarDrop, portfolioChanges } from "./portfolioViewModel.ts";
import type { PortfolioSnapshot } from "./source.ts";

describe("new mission", () => {
  it("slugs the name, skips taken slugs and lists the new mission", async () => {
    expect(newMissionInput("  ")).toEqual({ ok: false, error: "Name the mission." });
    expect(newMissionInput("Café Launch: Q4!")).toEqual({
      ok: true,
      value: { slug: "cafe-launch-q4", title: "Café Launch: Q4!" },
    });
    expect(newMissionInput("Gold", ["gold", "gold-2"])).toEqual({
      ok: true,
      value: { slug: "gold-3", title: "Gold" },
    });

    const source = createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) });
    let list: MissionListSnapshot | undefined;
    const close = source.subscribeList((next) => {
      list = next;
    });
    const built = newMissionInput("Gold");
    if (!built.ok) throw new Error(built.error);
    const id: MissionId = await source.createMission(built.value);
    expect(list?.missions.map((mission) => mission.id)).toContain(id);
    await expect(source.createMission(built.value)).rejects.toMatchObject({ code: "conflict" });
    close();
  });
});

describe("order bar drop", () => {
  it("moves the dragged mission into the drop place and ignores drops that move nothing", () => {
    const order = ["crpko", "juno", "gold"] as MissionId[];
    expect(orderBarDrop(order, "gold", "crpko")).toEqual({ order: ["gold", "crpko", "juno"] });
    expect(orderBarDrop(order, "crpko", "gold")).toEqual({ order: ["juno", "gold", "crpko"] });
    expect(orderBarDrop(order, "juno", "juno")).toBeNull();
    expect(orderBarDrop(order, "juno", null)).toBeNull();
    expect(orderBarDrop(order, "free", "juno")).toBeNull();
  });
});

describe("portfolio changes revert", () => {
  it("offers Revert on a tier or share change that kept its previous value", () => {
    const missionId = "crpko-engineering" as MissionId;
    const snapshot = {
      order: [missionId],
      missions: [
        {
          missionId,
          title: "Crpko engineering",
          status: "active",
          tier: "P0",
          masterRoleId: "crpko-master",
          guaranteedShare: 0.3,
          borrowCeiling: 0.5,
          usedShare: null,
          pools: [],
        },
      ],
      changes: [
        {
          ref: { kind: "mission", id: missionId },
          field: "tier",
          actor: { _tag: "owner" },
          eventId: "ev-2",
          at: "2026-10-19T10:00:02.000Z",
          previous: "P2",
        },
        {
          ref: { kind: "mission", id: missionId },
          field: "guaranteedShare",
          actor: { _tag: "owner" },
          eventId: "ev-1",
          at: "2026-10-19T10:00:01.000Z",
        },
      ],
      orderChange: { actor: { _tag: "owner" }, at: "2026-10-19T09:00:00.000Z", previousOrder: [] },
    } as unknown as PortfolioSnapshot;
    expect(portfolioChanges(snapshot).map((row) => [row.key, row.revert])).toEqual([
      [`${missionId}:tier`, { _tag: "mission", input: { missionId, tier: "P2" } }],
      [`${missionId}:guaranteedShare`, null],
      ["order", null],
    ]);
  });
});
