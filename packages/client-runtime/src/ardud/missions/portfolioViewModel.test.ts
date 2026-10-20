import type { MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import { newMissionInput } from "./portfolioViewModel.ts";
import type { MissionListSnapshot } from "./source.ts";

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
